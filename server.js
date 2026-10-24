'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, W = 3000, H = 3000, DT = 0.05;
const PUB = path.join(__dirname, 'public'), DB = path.join(__dirname, 'data.json');
const rnd = (a, b) => a + Math.random() * (b - a), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let lb = []; try { lb = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/healthz') return res.end('ok');
  if (p === '/') p = '/index.html';
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': path.extname(f) === '.html' ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(d);
  });
});

// クラス: hp, 攻撃, 連射, 弾数, 速度, 貫通, ノヴァ
const CL = [
  { hp: 100, dmg: 10, rate: 2.2, multi: 1, spd: 200, pierce: 0, nova: 0 },
  { hp: 80, dmg: 7, rate: 3.2, multi: 2, spd: 215, pierce: 0, nova: 0 },
  { hp: 170, dmg: 12, rate: 1.5, multi: 1, spd: 175, pierce: 0, nova: 1 }
];
const UP = [
  ['dmg', '💥 攻撃力 +25%', p => p.dmg *= 1.25],
  ['rate', '⚡ 連射 +20%', p => p.rate *= 1.2],
  ['multi', '🔱 弾数 +1', p => p.multi++],
  ['pierce', '🏹 貫通 +1', p => p.pierce++],
  ['spd', '👟 移動 +10%', p => p.spd *= 1.1],
  ['hp', '❤️ 最大HP +30 & 回復', p => { p.maxhp += 30; p.hp = Math.min(p.maxhp, p.hp + 60); }],
  ['mag', '🧲 吸収範囲 +40%', p => p.mag *= 1.4],
  ['regen', '💚 自動回復 +1.5/秒', p => p.regen += 1.5],
  ['nova', '🌀 ノヴァ(周囲爆発)強化', p => p.nova++],
  ['bspd', '🚀 弾速 +25%', p => p.bspd *= 1.25]
];
// 敵: hp, 速度, 半径, 接触DPS, 経験値
const T = [
  { hp: 20, sp: 70, r: 12, d: 12, xp: 1 }, { hp: 10, sp: 135, r: 9, d: 10, xp: 1 },
  { hp: 90, sp: 50, r: 20, d: 22, xp: 4 }, { hp: 600, sp: 60, r: 42, d: 40, xp: 60 }
];

let nextId = 1; const nid = () => nextId++;
const players = new Map();
let E = [], B = [], G = [], ev = [], wave = 1, wt = 0, acc = 0, over = 0;

function stats(cls, m) {
  const c = CL[cls] || CL[0], l = k => clamp((m && m[k]) | 0, 0, 10), maxhp = c.hp + l('hp') * 15;
  return {
    alive: true, hp: maxhp, maxhp, dmg: c.dmg * (1 + l('dmg') * .08), rate: c.rate, multi: c.multi, pierce: c.pierce,
    spd: c.spd * (1 + l('spd') * .03), bspd: 520, mag: 90, regen: 0, nova: c.nova, xpm: 1 + l('xp') * .08,
    xp: 0, lvl: 1, need: 20, kills: 0, cd: 0, nt: 2, q: 0, ch: null, x: W / 2 + rnd(-120, 120), y: H / 2 + rnd(-120, 120)
  };
}
function resetWorld() { E = []; B = []; G = []; wave = 1; wt = 0; acc = 0; over = 0; }
function send(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function offer(p) {
  if (p.ch || p.q <= 0) return; p.q--;
  const ids = UP.map((_, i) => i).sort(() => Math.random() - .5).slice(0, 3);
  p.ch = ids; send(p.ws, { t: 'lv', c: ids.map(i => UP[i][1]) });
}
function gain(p, v) {
  p.xp += v * p.xpm;
  while (p.xp >= p.need) { p.xp -= p.need; p.lvl++; p.need = Math.floor(p.need * 1.28 + 8); p.q++; }
  offer(p);
}
function hit(e, d, p) {
  if (e.dead) return; e.hp -= d;
  if (e.hp <= 0) {
    e.dead = true; p.kills++;
    if (G.length > 500) G[G.length - 1].v += e.xp; else G.push({ x: e.x, y: e.y, v: e.xp });
  }
}
function spawn(t, A) {
  const p = A[Math.random() * A.length | 0], a = rnd(0, 6.283), d = rnd(650, 800), b = T[t];
  const hp = b.hp * (1 + wave * .2 + wave * wave * .01);
  E.push({ id: nid(), t, x: clamp(p.x + Math.cos(a) * d, 10, W - 10), y: clamp(p.y + Math.sin(a) * d, 10, H - 10),
    hp, mh: hp, sp: b.sp * (1 + Math.min(wave, 20) * .01), r: b.r, d: b.d, xp: b.xp });
}
const pickType = () => { const r = Math.random(); return wave >= 4 && r < .15 ? 2 : wave >= 2 && r < .4 ? 1 : 0; };

function record(P) {
  for (const p of P) lb.push({ n: p.name, w: wave, k: p.kills, l: p.lvl });
  lb.sort((a, b) => b.w * 100000 + b.k - (a.w * 100000 + a.k)); lb = lb.slice(0, 10);
  fs.writeFile(DB, JSON.stringify(lb), () => {});
  for (const p of P) send(p.ws, { t: 'lb', l: lb });
}

function tick() {
  if (!players.size) { if (E.length || wave > 1) resetWorld(); return; }
  const P = [...players.values()], A = P.filter(p => p.alive); ev = [];
  if (!A.length) {
    if (!over) { over = 6; record(P); }
    over -= DT;
    if (over <= 0) { resetWorld(); P.forEach(p => Object.assign(p, stats(p.cls, p.m))); }
    return snap(P, A);
  }
  wt += DT; if (wt >= 30) { wt = 0; wave++; if (wave % 5 === 0) spawn(3, A); }
  acc += (1.2 + wave * .7) * (.6 + .4 * A.length) * DT;
  while (acc >= 1) { acc--; if (E.length < 260) spawn(pickType(), A); }

  for (const p of A) {
    p.x = clamp(p.x + p.ix * p.spd * DT, 20, W - 20); p.y = clamp(p.y + p.iy * p.spd * DT, 20, H - 20);
    p.hp = Math.min(p.maxhp, p.hp + p.regen * DT);
    if ((p.cd -= DT) <= 0) {
      let t = null, bd = 640 * 640;
      for (const e of E) { const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2; if (d < bd) { bd = d; t = e; } }
      if (t) {
        const a = Math.atan2(t.y - p.y, t.x - p.x), n = p.multi;
        for (let i = 0; i < n; i++) {
          const aa = a + (n > 1 ? (i - (n - 1) / 2) * .14 : 0);
          B.push({ id: nid(), x: p.x, y: p.y, vx: Math.cos(aa) * p.bspd, vy: Math.sin(aa) * p.bspd, dmg: p.dmg, life: 1.1, pc: p.pierce, o: p, h: [] });
        }
        p.cd = 1 / p.rate;
      } else p.cd = .1;
    }
    if (p.nova > 0 && (p.nt -= DT) <= 0) {
      p.nt = 4; const r = 100 + 25 * p.nova; ev.push([p.x | 0, p.y | 0, r]);
      for (const e of E) if ((e.x - p.x) ** 2 + (e.y - p.y) ** 2 < (r + e.r) ** 2) hit(e, p.dmg * (1 + p.nova) * 1.5, p);
    }
  }
  for (const b of B) {
    b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT;
    for (const e of E) {
      if (e.dead || b.h.includes(e.id)) continue;
      if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < (e.r + 5) ** 2) {
        hit(e, b.dmg, b.o); b.h.push(e.id);
        if (--b.pc < 0) { b.life = 0; break; }
      }
    }
  }
  B = B.filter(b => b.life > 0);
  for (const e of E) {
    if (e.dead) continue;
    let n = null, bd = 1e12;
    for (const p of A) { const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2; if (d < bd) { bd = d; n = p; } }
    const d = Math.sqrt(bd) || 1; e.x += (n.x - e.x) / d * e.sp * DT; e.y += (n.y - e.y) / d * e.sp * DT;
    if (d < e.r + 14) n.hp -= e.d * DT;
  }
  E = E.filter(e => !e.dead);
  for (const g of G) for (const p of A) {
    const dx = p.x - g.x, dy = p.y - g.y, d = Math.hypot(dx, dy);
    if (d < 18) { gain(p, g.v); g.v = 0; break; }
    if (d < p.mag) { g.x += dx / d * 420 * DT; g.y += dy / d * 420 * DT; break; }
  }
  G = G.filter(g => g.v > 0);
  for (const p of A) if (p.hp <= 0) {
    p.alive = false; p.ch = null;
    send(p.ws, { t: 'dead', wave, kills: p.kills, lvl: p.lvl, gold: p.kills + wave * 10 + p.lvl * 5 });
  }
  snap(P, A);
}

function snap(P, A) {
  const pl = P.map(p => [p.id, p.x | 0, p.y | 0, Math.max(0, p.hp / p.maxhp * 100) | 0, p.name, p.cls, p.alive ? 1 : 0, p.kills]);
  for (const p of P) {
    const c = p.alive ? p : (A[0] || p), near = (o, rx = 1000, ry = 700) => Math.abs(o.x - c.x) < rx && Math.abs(o.y - c.y) < ry;
    send(p.ws, {
      t: 's', id: p.id, w: wave, wt: Math.ceil(30 - wt), c: [c.x | 0, c.y | 0], pl, ev,
      me: { hp: p.hp | 0, mh: p.maxhp, xp: p.xp | 0, nd: p.need, lv: p.lvl, k: p.kills, a: p.alive ? 1 : 0 },
      e: E.filter(e => near(e)).map(e => [e.id, e.x | 0, e.y | 0, e.t, Math.max(0, e.hp / e.mh * 100) | 0]),
      b: B.filter(b => near(b)).map(b => [b.id, b.x | 0, b.y | 0]),
      g: G.filter(g => near(g)).map(g => [g.x | 0, g.y | 0])
    });
  }
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let p = null;
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'join' && !p && players.size < 24) {
      const cls = clamp(m.cls | 0, 0, CL.length - 1), mm = {};
      for (const k of ['hp', 'dmg', 'spd', 'xp']) mm[k] = clamp((m.m && m.m[k]) | 0, 0, 10);
      p = { id: nid(), ws, ix: 0, iy: 0, name: String(m.name || 'player').slice(0, 12), cls, m: mm };
      Object.assign(p, stats(cls, mm)); players.set(p.id, p); send(ws, { t: 'lb', l: lb });
    } else if (!p) return;
    else if (m.t === 'in') { let x = +m.x || 0, y = +m.y || 0; const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } p.ix = x; p.iy = y; }
    else if (m.t === 'pick' && p.ch) {
      const u = UP[p.ch[m.i | 0]]; if (u) { u[2](p); p.ch = null; offer(p); }
    }
  });
  ws.on('close', () => { if (p) players.delete(p.id); });
  ws.on('error', () => {});
});
setInterval(tick, DT * 1000);
server.listen(PORT, () => console.log('listening on ' + PORT));
