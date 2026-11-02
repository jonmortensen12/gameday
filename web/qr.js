/* Game Day - a QR code encoder, copied from Night Watch (from Mission Control, and Family Beatdown before it).
   Written out rather than fetched: the join code has to work on a wifi
   that cannot reach a CDN. qrMatrix(text, 'M') -> n x n array of 0/1.

   Byte mode, versions 1-10, error correction L or M. That is up to 271
   characters, and a join link is about seventy, so there is room for a
   longer host name without touching this.

   It is written out here rather than fetched because the whole game is
   one static page and the phones' first job is to reach it - a QR code
   that needs a CDN is a QR code that does not work on the wifi that
   made anyone want one.
   --------------------------------------------------------------- */

/* Reed-Solomon over GF(256), primitive polynomial 0x11d. */
var QR_EXP = new Array(512), QR_LOG = new Array(256);
(function(){
  for(var i = 0, x = 1; i < 255; i++){
    QR_EXP[i] = x; QR_LOG[x] = i;
    x <<= 1;
    if(x & 0x100) x ^= 0x11d;
  }
  for(var j = 255; j < 512; j++) QR_EXP[j] = QR_EXP[j - 255];
})();
function qrMul(a, b){ return (a === 0 || b === 0) ? 0 : QR_EXP[QR_LOG[a] + QR_LOG[b]]; }

/* The generator polynomial for n check bytes: (x-a^0)(x-a^1)...(x-a^n-1) */
function qrGenPoly(n){
  var g = [1];
  for(var i = 0; i < n; i++){
    var next = new Array(g.length + 1).fill(0);
    for(var j = 0; j < g.length; j++){
      next[j] ^= qrMul(g[j], 1);
      next[j+1] ^= qrMul(g[j], QR_EXP[i]);
    }
    g = next;
  }
  return g;
}

/* The remainder of data * x^n divided by the generator - the check bytes. */
function qrEcBytes(data, n){
  var g = qrGenPoly(n);
  var rem = data.concat(new Array(n).fill(0));
  for(var i = 0; i < data.length; i++){
    var lead = rem[i];
    if(!lead) continue;
    for(var j = 0; j < g.length; j++) rem[i+j] ^= qrMul(g[j], lead);
  }
  return rem.slice(data.length);
}

/* Per version and level: [blocks, total bytes per block, data bytes per
   block] and optionally a second group of longer blocks. Lifted from the
   standard's table; the two levels here are the ones a phone camera at
   arm's length has any use for. */
var QR_RS = {
  L: [[1,26,19],[1,44,34],[1,70,55],[1,100,80],[1,134,108],[2,86,68],[2,98,78],
      [2,121,97],[2,146,116],[2,86,68,2,87,69]],
  M: [[1,26,16],[1,44,28],[1,70,44],[2,50,32],[2,67,43],[4,43,27],[4,49,31],
      [2,60,38,2,61,39],[3,58,36,2,59,37],[4,69,43,1,70,44]]
};
var QR_ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],
                [6,26,46],[6,28,50]];
var QR_ECBITS = {L:1, M:0, Q:3, H:2};

/* How many data bytes a version holds at a level. */
function qrCapacity(ver, lvl){
  var r = QR_RS[lvl][ver-1], n = 0;
  for(var i = 0; i < r.length; i += 3) n += r[i] * r[i+2];
  return n;
}

/* UTF-8, so a name with an accent in it still scans. */
function qrBytes(text){
  var out = [];
  for(var i = 0; i < text.length; i++){
    var c = text.charCodeAt(i);
    if(c < 0x80) out.push(c);
    else if(c < 0x800){ out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else if(c < 0xd800 || c >= 0xe000){
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      var cp = 0x10000 + (((c & 0x3ff) << 10) | (text.charCodeAt(++i) & 0x3ff));
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
               0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return out;
}

/* Mask patterns 0-7. i is the row, j the column. */
function qrMaskAt(m, i, j){
  switch(m){
    case 0: return ((i + j) % 2) === 0;
    case 1: return (i % 2) === 0;
    case 2: return (j % 3) === 0;
    case 3: return ((i + j) % 3) === 0;
    case 4: return ((((i / 2) | 0) + ((j / 3) | 0)) % 2) === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0;
    default: return ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0;
  }
}

/* The four penalty rules, which is how the mask is chosen. */
function qrPenalty(g, n){
  var score = 0, i, j, k;
  // 1: runs of five or more of the same colour, either direction
  for(i = 0; i < n; i++){
    for(var dir = 0; dir < 2; dir++){
      var run = 1, prev = -1;
      for(j = 0; j < n; j++){
        var v = dir ? g[j][i] : g[i][j];
        if(v === prev) run++;
        else { if(run >= 5) score += run - 2; run = 1; prev = v; }
      }
      if(run >= 5) score += run - 2;
    }
  }
  // 2: any 2x2 block of one colour
  for(i = 0; i < n-1; i++) for(j = 0; j < n-1; j++){
    var a = g[i][j];
    if(a === g[i][j+1] && a === g[i+1][j] && a === g[i+1][j+1]) score += 3;
  }
  // 3: the finder-like 1:1:3:1:1 sequence with four light modules beside it
  var pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
  for(i = 0; i < n; i++) for(j = 0; j + 11 <= n; j++){
    var m1 = true, m2 = true;
    for(k = 0; k < 11; k++){
      if(g[i][j+k] !== pat1[k]) m1 = false;
      if(g[i][j+k] !== pat2[k]) m2 = false;
    }
    if(m1 || m2) score += 40;
  }
  for(j = 0; j < n; j++) for(i = 0; i + 11 <= n; i++){
    var v1 = true, v2 = true;
    for(k = 0; k < 11; k++){
      if(g[i+k][j] !== pat1[k]) v1 = false;
      if(g[i+k][j] !== pat2[k]) v2 = false;
    }
    if(v1 || v2) score += 40;
  }
  // 4: how far off half-and-half the whole picture is
  var dark = 0;
  for(i = 0; i < n; i++) for(j = 0; j < n; j++) dark += g[i][j];
  var pct = Math.abs(dark * 100 / (n*n) - 50);
  score += ((pct / 5) | 0) * 10;
  return score;
}

/* Returns an n x n array of 0/1, or null if the text will not fit. */
function qrMatrix(text, lvl){
  lvl = lvl || 'M';
  var data = qrBytes(text), ver = 0, i, j, k;
  for(i = 1; i <= 10; i++){
    // 4 bits of mode + 8 or 16 of length + the data itself
    var head = 4 + (i < 10 ? 8 : 16);
    if(data.length + Math.ceil(head / 8) <= qrCapacity(i, lvl) &&
       data.length * 8 + head <= qrCapacity(i, lvl) * 8){ ver = i; break; }
  }
  if(!ver) return null;

  /* ---- the bit stream ---- */
  var bits = [];
  function put(v, len){ for(var q = len-1; q >= 0; q--) bits.push((v >> q) & 1); }
  put(4, 4);                                   // byte mode
  put(data.length, ver < 10 ? 8 : 16);
  for(i = 0; i < data.length; i++) put(data[i], 8);
  var cap = qrCapacity(ver, lvl) * 8;
  for(i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // terminator
  while(bits.length % 8) bits.push(0);
  var words = [];
  for(i = 0; i < bits.length; i += 8){
    var byte = 0;
    for(j = 0; j < 8; j++) byte = (byte << 1) | bits[i+j];
    words.push(byte);
  }
  var padPair = [0xec, 0x11], p = 0;
  while(words.length < cap/8) words.push(padPair[p++ & 1]);

  /* ---- split into blocks, check each, then interleave ---- */
  var spec = QR_RS[lvl][ver-1], dblocks = [], eblocks = [], at = 0, ecLen = 0;
  for(i = 0; i < spec.length; i += 3){
    var count = spec[i], total = spec[i+1], dlen = spec[i+2];
    ecLen = total - dlen;
    for(k = 0; k < count; k++){
      var chunk = words.slice(at, at + dlen); at += dlen;
      dblocks.push(chunk);
      eblocks.push(qrEcBytes(chunk, ecLen));
    }
  }
  var out = [], maxD = 0;
  for(i = 0; i < dblocks.length; i++) maxD = Math.max(maxD, dblocks[i].length);
  for(i = 0; i < maxD; i++)
    for(j = 0; j < dblocks.length; j++)
      if(i < dblocks[j].length) out.push(dblocks[j][i]);
  for(i = 0; i < ecLen; i++)
    for(j = 0; j < eblocks.length; j++) out.push(eblocks[j][i]);

  /* ---- the grid ---- */
  var n = ver * 4 + 17;
  var g = [], fixed = [];
  for(i = 0; i < n; i++){ g.push(new Array(n).fill(0)); fixed.push(new Array(n).fill(0)); }
  function set(r, c, v){ g[r][c] = v; fixed[r][c] = 1; }

  function finder(r, c){
    for(var dr = -1; dr <= 7; dr++) for(var dc = -1; dc <= 7; dc++){
      var rr = r + dr, cc = c + dc;
      if(rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      var on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
               (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
               (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      set(rr, cc, on ? 1 : 0);
    }
  }
  finder(0, 0); finder(0, n-7); finder(n-7, 0);

  var al = QR_ALIGN[ver-1];
  for(i = 0; i < al.length; i++) for(j = 0; j < al.length; j++){
    var ar = al[i], ac = al[j];
    if(fixed[ar][ac]) continue;                 // the three finder corners
    for(var dr2 = -2; dr2 <= 2; dr2++) for(var dc2 = -2; dc2 <= 2; dc2++){
      var on2 = Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1;
      set(ar + dr2, ac + dc2, on2 ? 1 : 0);
    }
  }

  for(i = 8; i < n - 8; i++){                   // timing
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }
  set(n - 8, 8, 1);                             // the one module that is always dark

  // reserve the format strips
  for(i = 0; i < 9; i++){
    if(!fixed[8][i]) set(8, i, 0);
    if(!fixed[i][8]) set(i, 8, 0);
  }
  for(i = 0; i < 8; i++){
    if(!fixed[8][n-1-i]) set(8, n-1-i, 0);
    if(!fixed[n-1-i][8]) set(n-1-i, 8, 0);
  }
  if(ver >= 7){                                 // and the version strips
    for(i = 0; i < 6; i++) for(j = 0; j < 3; j++){
      set(i, n-11+j, 0); set(n-11+j, i, 0);
    }
  }

  /* ---- the data, in a zigzag up and down the columns ---- */
  var bit = 0, total = out.length * 8;
  function nextBit(){
    if(bit >= total) return 0;
    var v = (out[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return v;
  }
  var up = true;
  for(var col = n - 1; col > 0; col -= 2){
    if(col === 6) col--;                        // the vertical timing line
    for(var step = 0; step < n; step++){
      var row = up ? (n - 1 - step) : step;
      for(k = 0; k < 2; k++){
        var cc2 = col - k;
        if(fixed[row][cc2]) continue;
        g[row][cc2] = nextBit();
      }
    }
    up = !up;
  }

  /* ---- pick the mask by penalty, then write the format bits ----

     The score is taken with the format and version strips left blank,
     which is what the standard's own trial pass does. Scoring them
     filled in picks a different mask perfectly legally and then reads
     back as a different code than every other encoder writes. */
  var best = null, bestScore = Infinity;
  for(var m = 0; m < 8; m++){
    var t = [];
    for(i = 0; i < n; i++){
      t.push(g[i].slice());
      for(j = 0; j < n; j++) if(!fixed[i][j] && qrMaskAt(m, i, j)) t[i][j] ^= 1;
    }
    writeFormat(t, m, true);
    var sc = qrPenalty(t, n);
    if(sc < bestScore){ bestScore = sc; best = t; writeFormat(best, m, false); }
  }
  return best;

  function writeFormat(t, mask, blank){
    var f = (QR_ECBITS[lvl] << 3) | mask, d = f << 10, q;
    for(q = 4; q >= 0; q--) if(d & (1 << (q + 10))) d ^= 0x537 << q;
    var fmt = ((f << 10) | d) ^ 0x5412;
    t[n - 8][8] = blank ? 0 : 1;                 // the always-dark module
    for(q = 0; q < 15; q++){
      var b = blank ? 0 : (fmt >> q) & 1;
      // down the column beside the top-left finder, hopping the timing row
      if(q < 6) t[q][8] = b;
      else if(q < 8) t[q + 1][8] = b;
      else t[n - 15 + q][8] = b;
      // and along the row, the same fifteen bits split the other way
      if(q < 8) t[8][n - 1 - q] = b;
      else if(q === 8) t[8][7] = b;
      else t[8][14 - q] = b;
    }
    if(ver >= 7){
      var vd = ver << 12;
      for(q = 5; q >= 0; q--) if(vd & (1 << (q + 12))) vd ^= 0x1f25 << q;
      var vinfo = (ver << 12) | vd;
      for(q = 0; q < 18; q++){
        var vb = blank ? 0 : (vinfo >> q) & 1;
        t[(q / 3) | 0][n - 11 + (q % 3)] = vb;
        t[n - 11 + (q % 3)][(q / 3) | 0] = vb;
      }
    }
  }
}
