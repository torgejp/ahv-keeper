// AutoHedgeVault keeper: 自動 rebalance + 異常通知(ntfy)
// 使い方: node keeper.mjs   (GitHub Actions / cron から5〜10分おきに実行)
// 環境変数:
//   VAULT       対象vault (v7 のアドレス。必須)
//   NTFY_TOPIC  通知先トピック名 (ntfy.sh)。未設定ならコンソール表示のみ
//   KEEPER_PK   rebalance送信用の使い捨てウォレット秘密鍵。未設定なら「監視+通知のみ」
//   DRY_RUN=1   送信せず内容だけ表示
//   STATE_FILE  通知の間引き用の状態ファイル (既定 .keeper-state.json)
//   RPC_URL / INFO_URL / NTFY_URL  接続先の上書き(テスト用)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// 秘密鍵の前後の空白・引用符・改行を除き、0x が無ければ補う(GitHub の Secret に貼るとき混ざりやすい)
function normPk(v) { let x = String(v || '').trim().replace(/^["']|["']$/g, '').trim(); if (/^[0-9a-fA-F]{64}$/.test(x)) x = '0x' + x; return x; }
const CFG = {
  vault: process.env.VAULT || '',
  rpc: process.env.RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  info: process.env.INFO_URL || 'https://api.hyperliquid.xyz/info',
  ntfy: process.env.NTFY_URL || 'https://ntfy.sh',
  topic: process.env.NTFY_TOPIC || '',
  pk: normPk(process.env.KEEPER_PK),
  dry: process.env.DRY_RUN === '1',
  stateFile: process.env.STATE_FILE || '.keeper-state.json',
  label: process.env.LABEL || '',   // 複数の vault を動かすときの見分け用(通知の題名の先頭に付く)
};
const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f';
const ERR = { '0x12626b5b': 'WithinBand', '0x445636e6': 'Settling', '0x92f952a5': 'NeedSettle', '0x94e8dec3': 'PriceDeviation',  '0x599e2c44': 'WithinThreshold', '0x8d8543e8': 'BelowMinNotional', '0x19954086': 'SizeBelowLot', '0x4dfba023': 'ZeroPrice', '0x4795c6b4': 'ReadFailed', '0x3204506f': 'CallFailed', '0xab143c06': 'Reentrancy' };
// しきい値
const T = { liqWarn: 0.12, liqUrgent: 0.07, levWarn: 5, feeUnsentUsd: 5, gapRatio: 0.2, minNotionalForGap: 12, keeperGasMin: 0.01 };

const pad = (x) => x.toLowerCase().replace('0x', '').padStart(64, '0');
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { let b = ''; try { b = (await r.text()).slice(0, 200); } catch {} throw new Error(`${url} -> HTTP ${r.status} ${b}`); }
  return r.json();
}
// RPCノード側の一時的な不調(例: invalid block height)かどうか
export const isTransient = (e) => /invalid block height|coalesce|timeout|timed out|rate limit|too many|temporar|HTTP 5\d\d|ECONNRESET|fetch failed|-32603|-32005/i.test(String((e && e.message) || e));
export async function rpc(method, params) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const j = await post(CFG.rpc, { jsonrpc: '2.0', id: 1, method, params });
      if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.data = j.error.data; throw e; }
      return j.result;
    } catch (e) {
      last = e;
      // コントラクトのrevert(dataあり)は再試行しない。ノードの一時的な不調だけ待って再試行する
      if (e.data || !isTransient(e) || i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}
const ethCall = (to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const u = async (to, data) => BigInt(await ethCall(to, data));
const s = async (to, data) => BigInt.asIntN(256, BigInt(await ethCall(to, data)));

let hedgerAddr = null;
async function getHedger() {
  if (!hedgerAddr) hedgerAddr = '0x' + (await ethCall(CFG.vault, '0x079cff94')).slice(26);
  return hedgerAddr;
}
export async function readVault() {
  const V = CFG.vault, H = await getHedger();
  const [hedge, target, price, lp, nav, vUsdc, supply] = await Promise.all([
    s(V, '0xe8f4cc0d'), s(V, '0xdb4a4198'), u(H, '0x668aa824'), u(V, '0x17e7d9ce'), u(V, '0xd2c0dc14'),
    u(USDC, '0x70a08231' + pad(V)), u(V, '0x18160ddd')]);
  const hUsdc = await u(USDC, '0x70a08231' + pad(H));
  return { hedge: Number(hedge) / 1e8, target: Number(target) / 1e8, price: Number(price) / 1e4, lpBase: Number(lp) / 1e18,
    nav: Number(nav) / 1e18, feeReserve: 0, vaultUsdc: Number(vUsdc) / 1e6, executorUsdc: Number(hUsdc) / 1e6, supply: Number(supply) / 1e18 };
}
export async function readCore() {
  const p = await post(CFG.info, { type: 'clearinghouseState', user: await getHedger() });
  const pos = (p.assetPositions || []).map((a) => a.position).find((x) => x.coin === 'HYPE');
  return { accountValue: Number(p.marginSummary.accountValue), withdrawable: Number(p.withdrawable),
    szi: pos ? Number(pos.szi) : 0, liqPx: pos && pos.liquidationPx ? Number(pos.liquidationPx) : null,
    notional: pos ? Math.abs(Number(pos.positionValue)) : 0 };
}

// ---- 通知 (同じ種類は cooldown 時間内は再送しない) ----
let state = {};
const loadState = () => { try { state = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch { state = {}; } };
const saveState = () => { try { fs.writeFileSync(CFG.stateFile, JSON.stringify(state)); } catch (e) { console.log('state保存失敗', e.message); } };
export const sent = [];
export async function alert(key, cooldownH, priority, title, message, tags = 'warning') {
  const now = Date.now();
  if (state[key] && now - state[key] < cooldownH * 3600e3) { console.log(`(間引き) ${key}: ${title}`); return; }
  console.log(`🔔 [${priority}] ${title} — ${message}`);
  sent.push({ key, priority, title, message });
  if (!CFG.topic) { state[key] = now; return; }
  const PRI = { min: 1, low: 2, default: 3, high: 4, urgent: 5 }; // ntfy の JSON 送信は優先度を数字(1〜5)で指定する
  try { await post(CFG.ntfy, { topic: CFG.topic, title: (CFG.label ? '[' + CFG.label + '] ' : '') + title, message, priority: PRI[priority] || 3, tags: [tags] }); state[key] = now; } // 送信できたときだけ「通知済み」にする
  catch (e) { console.log('ntfy送信失敗', e.message); }
}
const clear = (key) => { delete state[key]; };

// ---- rebalance送信 ----
export async function sendTxTo(data, gasLimit = 800000) {
  const { ethers } = await import('ethers');
  const prov = new ethers.JsonRpcProvider(CFG.rpc, undefined, { staticNetwork: true });
  const w = new ethers.Wallet(CFG.pk, prov);
  const tx = await w.sendTransaction({ to: CFG.vault, data, gasLimit });
  const r = await tx.wait();
  return { hash: tx.hash, status: r.status };
}
async function keeperBalance() {
  const { ethers } = await import('ethers');
  return Number(await rpc('eth_getBalance', [new ethers.Wallet(CFG.pk).address, 'latest'])) / 1e18;
}

export async function main() {
  loadState();
  if (!/^0x[0-9a-fA-F]{40}$/.test(CFG.vault)) { await alert('bad_vault', 3, 'high', 'AutoHedge: VAULT の設定が不正です', `VAULT="${CFG.vault}" はアドレス(0x+40桁)ではありません。ワークフローの VAULT を確認してください。`, 'rotating_light'); saveState(); return 1; }
  let v, c;
  try { v = await readVault(); c = await readCore(); }
  catch (e) { await alert('read_fail', 3, 'high', 'AutoHedge: データを取得できません', String(e.message || e), 'rotating_light'); saveState(); return 1; }
  clear('read_fail');
  // 鍵の「形」だけを表示(値は出さない)。invalid private key の原因切り分け用
  if (CFG.pk) {
    const raw = String(process.env.KEEPER_PK || '');
    const hex = CFG.pk.replace(/^0x/, '');
    console.log(`KEEPER_PK の形: 元の長さ=${raw.length} / 補正後の長さ=${CFG.pk.length}(正しくは 66) / 0xで始まる=${CFG.pk.startsWith('0x')} / 16進のみ=${/^[0-9a-fA-F]*$/.test(hex)} / 空白を含む=${/\s/.test(raw)} / 単語数=${raw.trim().split(/\s+/).length}`);
  } else console.log('KEEPER_PK は未設定(空)');
  console.log('vault', v, '\ncore', c);
  if (v.supply > 0) try { fs.writeFileSync(process.env.SNAPSHOT_FILE || 'snapshot.json', JSON.stringify({ t: Math.floor(Date.now() / 1000), px: v.nav / v.supply, price: v.price, nav: v.nav, supply: v.supply, hedge: v.hedge })); } catch (e) { console.log('snapshot保存失敗', e.message); }

  const notionalLp = v.lpBase * v.price;
  const needHedge = Math.abs(v.target) * v.price >= 10;

  // 1) rebalance
  let rbNote = '';
  try {
    await ethCall(CFG.vault, '0x7d7c2a1c', CFG.pk ? undefined : '0x000000000000000000000000000000000000dEaD');
    if (!CFG.pk) { rbNote = 'rebalance可能(鍵未設定のため送信せず)'; await alert('rb_needed', 1, 'default', 'AutoHedge: rebalanceが必要です', `現在 ${v.hedge} / 目標 ${v.target} HYPE。keeperの鍵が無いので手動で実行してください。`); }
    else if (CFG.dry) rbNote = 'DRY_RUN: rebalanceを送信するところ';
    else {
      const r = await sendTxTo('0x7d7c2a1c');
      rbNote = `rebalance送信 ${r.hash} status=${r.status}`;
      if (String(r.status) !== '1') await alert('rb_fail', 1, 'high', 'AutoHedge: rebalanceが失敗しました', r.hash, 'rotating_light'); else clear('rb_fail');
    }
  } catch (e) {
    const sel = String(e.data || '').slice(0, 10);
    const name = ERR[sel] || (sel ? sel : String(e.message || e).slice(0, 80));
    if (name === 'WithinThreshold') rbNote = '許容範囲内(rebalance不要)';
    else if (name === 'BelowMinNotional' && !needHedge) rbNote = '小額のためヘッジ対象外';
    else if (name === 'BelowMinNotional' && Math.abs(v.target - v.hedge) * v.price < 10) rbNote = `差が小さく最小注文額(約$10)未満のため調整待ち(差 約$${(Math.abs(v.target - v.hedge) * v.price).toFixed(1)})`;
    else { rbNote = 'rebalance不可: ' + name; await alert('rb_fail', 1, 'high', 'AutoHedge: rebalanceできません', `${name} / 現在 ${v.hedge} 目標 ${v.target} HYPE`, 'rotating_light'); }
  }
  console.log(rbNote);

  // 1b) settle: ヘッジ口座の証拠金を目標帯(名目の22〜38%)に保つ。足りないとき/余るときに実行される(帯の中なら WithinBand)
  try {
    await ethCall(CFG.vault, '0x11da60b4', CFG.pk ? undefined : '0x000000000000000000000000000000000000dEaD'); state.settle_rpc_err = 0;
    if (!CFG.pk) await alert('settle_needed', 1, 'high', 'AutoHedge: settle(証拠金の調整)が必要です', '鍵未設定のため送信しません。手動で settle() を実行してください。', 'warning');
    else if (CFG.dry) console.log('DRY_RUN: settleを送信するところ');
    else {
      const r = await sendTxTo('0x11da60b4', 2_500_000);
      console.log(`settle送信 ${r.hash} status=${r.status}`);
      if (String(r.status) !== '1') await alert('settle_fail', 1, 'high', 'AutoHedge: settleが失敗しました', r.hash, 'rotating_light'); else { clear('settle_fail'); clear('settle_needed'); }
    }
  } catch (e) {
    const sel = String(e.data || '').slice(0, 10), name = ERR[sel] || (sel || String(e.message || e).slice(0, 80));
    if (name === 'WithinBand' || name === 'Settling') { state.settle_rpc_err = 0; clear('settle_fail'); clear('settle_needed'); console.log('settle不要: ' + name); }
    else if (!e.data && isTransient(e)) {
      // ノードの一時的な不調。1回だけでは通知せず、3回連続(約30分)続いたときだけ通知する
      state.settle_rpc_err = (state.settle_rpc_err || 0) + 1; console.log(`settle確認: RPCの一時エラー(${state.settle_rpc_err}回連続): ${name}`);
      if (state.settle_rpc_err >= 3) await alert('settle_rpc', 3, 'default', 'AutoHedge: settleの確認がRPCエラーで3回続けて失敗', name, 'warning');
    }
    else await alert('settle_fail', 1, 'high', 'AutoHedge: settleできません', `${name}(証拠金が不足していると清算の恐れ)`, 'rotating_light');
  }

  // 2) 清算までの距離・レバレッジ
  if (c.szi < 0 && c.liqPx) {
    const dist = (c.liqPx - v.price) / v.price;
    if (dist < T.liqUrgent) await alert('liq_urgent', 1, 'urgent', 'AutoHedge: 清算が近づいています', `清算価格 $${c.liqPx.toFixed(2)} / 現在 $${v.price.toFixed(2)}(あと +${(dist * 100).toFixed(0)}%)。証拠金を追加してください。`, 'rotating_light');
    else if (dist < T.liqWarn) await alert('liq_warn', 6, 'high', 'AutoHedge: 清算価格が近め', `清算 $${c.liqPx.toFixed(2)} / 現在 $${v.price.toFixed(2)}(+${(dist * 100).toFixed(0)}%)。`);
    else { clear('liq_urgent'); clear('liq_warn'); }
  }
  if (c.notional > 0) {
    const lev = c.notional / Math.max(c.accountValue, 0.01);
    if (lev > T.levWarn) await alert('lev', 6, 'high', 'AutoHedge: 証拠金が薄くなっています', `ヘッジ想定元本 $${c.notional.toFixed(0)} に対し証拠金 $${c.accountValue.toFixed(1)}(約${lev.toFixed(1)}倍)。`);
    else clear('lev');
  }
  // 3) 手数料の未送金
  // 4) ヘッジのずれ(rebalance後も解消しない場合)
  if (needHedge && !rbNote.startsWith('rebalance送信')) {
    const gap = Math.abs(v.hedge - v.target) / Math.max(Math.abs(v.target), 1e-9);
    if (gap > T.gapRatio && Math.abs(v.target) * v.price >= T.minNotionalForGap) await alert('gap', 3, 'high', 'AutoHedge: ヘッジが目標からずれています', `現在 ${v.hedge} / 目標 ${v.target} HYPE(${rbNote})`);
    else clear('gap');
  }
  // 5) keeperのガス
  if (CFG.pk) { try { const b = await keeperBalance(); if (b < T.keeperGasMin) await alert('gas', 24, 'high', 'AutoHedge: keeperのガス(HYPE)が不足', `残高 ${b.toFixed(4)} HYPE。少額を送ってください。`); } catch {} }
  // 6) 1日1回の生存通知
  await alert('heartbeat', 24, 'min', 'AutoHedge: 稼働中', `NAV $${v.nav.toFixed(2)} / LP内HYPE ${v.lpBase.toFixed(3)} / ヘッジ ${v.hedge} / 証拠金 $${c.accountValue.toFixed(1)}` + (c.liqPx ? ` / 清算 $${c.liqPx.toFixed(1)}(現在$${v.price.toFixed(1)})` : '') + ` / ${rbNote}`, 'white_check_mark');
  saveState();
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
