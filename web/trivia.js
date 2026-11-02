/* Game Day - trivia for the commercial breaks.

   The written bank first. Every fact here was checked against a source in
   November 2026 (Wikipedia's Holy War article, the schools' athletics
   sites, ESPN); where the sources disagree - the all-time record most of
   all - the question asks about the disagreement, not a number.

   {id, q, a: [right answer, wrong, wrong, wrong], kid: true for the kids'
   bank}. The right answer is always first here; rounds shuffle them.

   Then the live questions, made at the moment a round starts from what the
   feed knows about today's game (the stat leaders, the score, who scored),
   so the room is quizzed on the game it is watching. */

export const BANK = [
  // ---- the rivalry ----
  {id: 'r-ferrin', q: 'Who kicked the 44-yard field goal with 4 seconds left to beat Utah 22-21 in 2024?', a: ['Will Ferrin', 'Jake Oldroyd', 'Matt Payne', 'Justen Smith']},
  {id: 'r-2025', q: 'Last year (2025) in Provo, BYU beat Utah by what score?', a: ['24-21', '22-21', '26-17', '31-28']},
  {id: 'r-streak', q: 'Going into today, how many straight games has BYU won against Utah?', a: ['3', '1', '5', '9']},
  {id: 'r-2021', q: 'BYU\'s 26-17 win in 2021 snapped a Utah winning streak in the series of how many games?', a: ['9', '4', '6', '12']},
  {id: 'r-boot', q: 'What is the trophy that goes to the winner of the in-state football rivalries?', a: ['The Beehive Boot', 'The Golden Spike', 'The Deseret Cup', 'The Wasatch Bell']},
  {id: 'r-name', q: 'Where did the name "Holy War" come from?', a: ['Local sports talk radio in the 1990s', 'A 1922 newspaper headline', 'LaVell Edwards in a press conference', 'An ESPN broadcast in 2010']},
  {id: 'r-1980', q: 'BYU\'s biggest margin of victory in the series came in 1980. What was the score?', a: ['56-6', '70-31', '45-7', '38-0']},
  {id: 'r-1989', q: 'BYU beat Utah 70-31 in 1989. What record does that game still hold?', a: ['Most combined points (101)', 'Longest game ever played', 'First game on national TV', 'Most fumbles in a game']},
  {id: 'r-1984', q: 'BYU beat Utah 24-14 in 1984. How did that season end?', a: ['With a national championship', 'With a Rose Bowl win', 'With a loss to Utah State', 'With a Heisman for Steve Young']},
  {id: 'r-harline', q: '2006: "_____ is still open!" Which receiver caught John Beck\'s last-second game-winner?', a: ['Jonny Harline', 'Austin Collie', 'Dennis Pitta', 'Cody Hoffman']},
  {id: 'r-george', q: '2009: BYU fans still say "George is still running." Who threw him the overtime touchdown?', a: ['Max Hall', 'John Beck', 'Taysom Hill', 'Ty Detmer']},
  {id: 'r-2007', q: 'In 2007 BYU kept its winning drive alive on a 4th-and-what?', a: ['4th-and-18', '4th-and-1', '4th-and-goal', '4th-and-27']},
  {id: 'r-1942', q: 'BYU did not win a game in the series until what year?', a: ['1942', '1922', '1958', '1965']},
  {id: 'r-record', q: 'Why don\'t BYU and Utah agree on the all-time series record?', a: ['Utah counts 1890s games against Brigham Young Academy', 'A forfeit in 1936 is disputed', 'BYU counts its bowl game against Utah twice', 'A 1960s game was never finished']},
  {id: 'r-bowl', q: 'The only time BYU and Utah met in a bowl game was the 2015 ______ Bowl.', a: ['Las Vegas', 'Holiday', 'Fiesta', 'Armed Forces']},
  {id: 'r-2010', q: 'In 2010 Utah won 17-16 when Brandon Burton did what at the end?', a: ['Blocked BYU\'s game-winning field goal', 'Intercepted a Hail Mary', 'Returned a punt for a touchdown', 'Recovered an onside kick']},
  {id: 'r-2018', q: 'Utah\'s 2018 win was the biggest comeback in the series. How far behind were the Utes?', a: ['27-7', '21-0', '35-14', '17-3']},
  {id: 'r-10am', q: 'Today is the first 10 a.m. kickoff in the rivalry since what year?', a: ['1996', '1984', '2009', '2019']},
  {id: 'r-big12', q: 'BYU joined the Big 12 in 2023. When did Utah join?', a: ['2024', '2023', '2022', '2025']},
  {id: 'r-tds', q: 'Which coach gave Utah fans the nickname "Team Down South" for BYU?', a: ['Urban Meyer', 'Kyle Whittingham', 'Ron McBride', 'Lou Holtz']},
  {id: 'r-first', q: 'By BYU\'s count, the first game was in 1922. Who won it?', a: ['Utah, 49-0', 'BYU, 7-6', 'Utah, 14-12', 'It was a tie, 0-0']},
  {id: 'r-ot', q: 'The first overtime game in the series was in 2005. Who won?', a: ['Utah, 41-34', 'BYU, 26-23', 'BYU, 33-31', 'Utah, 17-16']},
  {id: 'r-martin', q: 'Who led BYU in rushing in last year\'s win over Utah, with 122 yards?', a: ['LJ Martin', 'Sione Moa', 'Bear Bachmeier', 'Parker Kingston']},
  // ---- BYU ----
  {id: 'b-lavell', q: 'LaVell Edwards coached BYU for how many seasons?', a: ['29', '19', '35', '25']},
  {id: 'b-detmer', q: 'Which BYU quarterback won the Heisman Trophy in 1990?', a: ['Ty Detmer', 'Jim McMahon', 'Steve Young', 'Robbie Bosco']},
  {id: 'b-young', q: 'Steve Young won Super Bowl XXIX MVP with which team?', a: ['San Francisco 49ers', 'Tampa Bay Buccaneers', 'Dallas Cowboys', 'Denver Broncos']},
  {id: 'b-brigham', q: 'Steve Young is a descendant of which famous Utahn?', a: ['Brigham Young', 'Butch Cassidy', 'John Moses Browning', 'Philo Farnsworth']},
  {id: 'b-miami', q: 'In 1990 BYU upset which No. 1-ranked team?', a: ['Miami', 'Notre Dame', 'Florida State', 'Nebraska']},
  {id: 'b-song', q: 'What is BYU\'s fight song?', a: ['Rise and Shout', 'Utah Man', 'Cougar Fight', 'Go Cougars Go']},
  {id: 'b-roc', q: 'What is BYU\'s student section called?', a: ['The ROC', 'The MUSS', 'The Den', 'The Blue Crew']},
  {id: 'b-sitake', q: 'This is Kalani Sitake\'s ___ season as BYU\'s head coach.', a: ['11th', '8th', '10th', '13th']},
  {id: 'b-ucf', q: 'BYU\'s only loss this season came against which team?', a: ['UCF', 'Arizona State', 'Notre Dame', 'TCU']},
  {id: 'b-stadium', q: 'BYU\'s home stadium is named after whom?', a: ['LaVell Edwards', 'Brigham Young', 'Karl G. Maeser', 'Gordon B. Hinckley']},
  {id: 'b-cosmo', q: 'Cosmo the Cougar\'s dance with the Cougarettes went viral in what year?', a: ['2017', '2010', '2021', '2014']},
  // ---- this season ----
  {id: 's-utah8', q: 'Utah came in 8-0 for the first time since what year?', a: ['2010', '2004', '2019', '2008']},
  {id: 's-pick6', q: 'Utah has scored a pick-six in how many straight seasons?', a: ['23', '10', '15', '31']},
  {id: 's-where', q: 'Where is today\'s game being played?', a: ['Rice-Eccles Stadium', 'LaVell Edwards Stadium', 'Maverik Stadium', 'Allegiant Stadium']},
  // ---- football ----
  {id: 'f-safety', q: 'How many points is a safety worth?', a: ['2', '1', '3', '6']},
  {id: 'f-2pt', q: 'After a touchdown, from what yard line does a college two-point try start?', a: ['The 3', 'The 2', 'The 5', 'The 10']},
  {id: 'f-11', q: 'How many players does each team have on the field?', a: ['11', '10', '12', '9']},

  // ---- the kids' bank: big, friendly, picture-able ----
  {id: 'k-cosmo', kid: true, q: 'What animal is Cosmo?', a: ['🐆 A cougar', '🦅 A hawk', '🐻 A bear', '🐺 A wolf']},
  {id: 'k-swoop', kid: true, q: 'Utah\'s mascot Swoop is what kind of animal?', a: ['🦅 A hawk', '🐆 A cougar', '🦉 An owl', '🐍 A snake']},
  {id: 'k-td', kid: true, q: 'How many points is a touchdown?', a: ['6', '3', '1', '10']},
  {id: 'k-fg', kid: true, q: 'How many points is a field goal?', a: ['3', '6', '1', '2']},
  {id: 'k-pat', kid: true, q: 'How many points for a kick after a touchdown?', a: ['1', '2', '3', '6']},
  {id: 'k-color', kid: true, q: 'What color does BYU wear?', a: ['💙 Blue', '❤️ Red', '💚 Green', '💛 Yellow']},
  {id: 'k-ucolor', kid: true, q: 'What color does Utah wear?', a: ['❤️ Red', '💙 Blue', '💜 Purple', '🧡 Orange']},
  {id: 'k-ball', kid: true, q: 'What shape is a football?', a: ['🏈 Like an egg with points', '⚽ Round like a ball', '🎲 A cube', '⭐ A star']},
  {id: 'k-11', kid: true, q: 'How many players from one team are on the field?', a: ['11', '5', '20', '100']},
  {id: 'k-throw', kid: true, q: 'Who throws the ball most of the time?', a: ['The quarterback', 'The kicker', 'The referee', 'The mascot']},
  {id: 'k-ref', kid: true, q: 'What does a referee throw when there is a penalty?', a: ['🟨 A yellow flag', '🏈 A football', '🧢 A hat', '🍌 A banana']},
  {id: 'k-y', kid: true, q: 'What big letter is on the mountain above Provo?', a: ['Y', 'U', 'P', 'B']},
  {id: 'k-ez', kid: true, q: 'Where do you score a touchdown?', a: ['The end zone', 'The bench', 'The locker room', 'The parking lot']},
  {id: 'k-100', kid: true, q: 'How many yards long is the field, goal line to goal line?', a: ['100', '10', '50', '1,000']},
  {id: 'k-song', kid: true, q: 'BYU\'s fight song says "Rise and ___!"', a: ['Shout', 'Shine', 'Run', 'Sing']},
  {id: 'k-q', kid: true, q: 'How many quarters are in a football game?', a: ['4', '2', '3', '6']},
  {id: 'k-kick', kid: true, q: 'Which player kicks field goals?', a: ['The kicker', 'The quarterback', 'The coach', 'The cheerleader']},
  {id: 'k-cougar', kid: true, q: 'What sound does a cougar make?', a: ['🐆 A growl', '🐄 Moo', '🦆 Quack', '🐑 Baa']},
  {id: 'k-tail', kid: true, q: 'A "Cougar Tail" at BYU games is something you...', a: ['🍩 Eat (it\'s a long maple donut)', '👕 Wear', '🎺 Play', '🎈 Pop']},
  {id: 'k-hut', kid: true, q: 'What does the quarterback yell before the snap?', a: ['"Hut!"', '"Go fish!"', '"Bingo!"', '"Cheese!"']},
];

/* Questions about the game being watched, from the feed: who is leading
   in passing, rushing and receiving for the room's team, and the score.
   Wrong answers come from the same team's box score, so they are real
   names from today. Returns [] when the feed has not got that far. */
export function liveQuestions(N, team, seed){
  const out = [];
  if(!N) return out;
  const T = N.teams[team], opp = Object.values(N.teams).find(t => t.id !== team);
  const names = ((N.roster || []).find(r => r.team === team) || {names: []}).names;
  const pickWrong = (right, pool, n) => {
    const p = pool.filter(x => x && x !== right);
    const res = [];
    let s = seed >>> 0;
    while(p.length && res.length < n){ s = (s * 1103515245 + 12345) >>> 0; res.push(p.splice(s % p.length, 1)[0]); }
    return res;
  };
  const lead = (N.leaders || []).find(l => l.team === team);
  const words = {passingYards: 'passing yards', rushingYards: 'rushing yards', receivingYards: 'receiving yards'};
  if(T && lead) lead.cats.forEach(c => {
    if(!words[c.name] || !c.who) return;
    const wrong = pickWrong(c.who, names, 3);
    if(wrong.length < 3) return;
    out.push({id: 'live-' + c.name + '-' + c.who, live: true,
      q: 'Who leads ' + T.name + ' in ' + words[c.name] + ' so far today?', a: [c.who].concat(wrong), note: c.who + ': ' + c.line});
  });
  if(T && opp && N.status && N.status.state === 'in'){
    const diff = T.score - opp.score;
    const right = diff > 0 ? T.name + ' by ' + diff : diff < 0 ? opp.name + ' by ' + (-diff) : 'Tied';
    const opts = new Set([right]);
    [3, 7, 10, 14, 1, 4].forEach(k => { if(opts.size < 4) opts.add(diff > 0 ? T.name + ' by ' + (diff + k) : T.name + ' by ' + k); });
    opts.add('Tied');
    const arr = [...opts].slice(0, 4);
    if(!arr.includes(right)) arr[3] = right;
    out.push({id: 'live-score-' + T.score + '-' + opp.score, live: true, q: 'Quick - without looking: what\'s the score right now?',
      a: [right].concat(arr.filter(x => x !== right)).slice(0, 4)});
  }
  return out;
}
