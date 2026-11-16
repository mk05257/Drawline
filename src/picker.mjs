export const GAMES = {ca649: {name: 'Lotto 6/49', size: 6, pool: 49}, lottomax: {name: 'Lotto Max', size: 7, pool: 52}};
export function randomBelow(n) {
  const limit = Math.floor(2 ** 32 / n) * n;
  const word = new Uint32Array(1);
  do { crypto.getRandomValues(word); } while (word[0] >= limit);
  return word[0] % n;
}
export function validLine(line) {
  const g = GAMES[line?.game];
  return !!g && Array.isArray(line.numbers) && line.numbers.length === g.size && new Set([...line.numbers, line.bonus]).size === g.size + 1 && [...line.numbers, line.bonus].every(n => Number.isInteger(n) && n >= 1 && n <= g.pool);
}
export function pickLines(game, count) {
  const g = GAMES[game];
  if (!g || !Number.isInteger(count) || count < 1 || count > 10) throw Error('Choose 1–10 lines.');
  const lines = [], seen = new Set();
  while (lines.length < count) {
    const pool = Array.from({length:g.pool}, (_, i) => i + 1);
    for (let i = 0; i <= g.size; i++) {
      const j = i + randomBelow(g.pool - i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const numbers = pool.slice(0,g.size).sort((a,b)=>a-b), key = numbers.join(',');
    if (!seen.has(key)) { seen.add(key); lines.push({game, numbers, bonus:pool[g.size]}); }
  }
  return lines;
}
