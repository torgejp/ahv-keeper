// snapshot.json を history.json に追記する(前回から50分以上たっていれば)
// 使い方: node record.mjs <history.json> <snapshot.json>
import fs from 'node:fs';
const [hf, sf] = process.argv.slice(2);
let snap; try { snap = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { console.log('snapshotなし'); process.exit(0); }
let h = { v: 1, cols: ['t', 'px', 'price', 'nav', 'supply', 'hedge'], rows: [] };
try { h = JSON.parse(fs.readFileSync(hf, 'utf8')); } catch {}
const last = h.rows[h.rows.length - 1];
if (last && snap.t - last[0] < 50 * 60) { console.log('間隔が短いので記録しない'); process.exit(0); }
const r = (x, d) => Number(x.toFixed(d));
h.rows.push([snap.t, r(snap.px, 6), r(snap.price, 4), r(snap.nav, 2), r(snap.supply, 4), r(snap.hedge, 2)]);
fs.writeFileSync(hf, JSON.stringify(h));
console.log('記録しました', h.rows.length);
