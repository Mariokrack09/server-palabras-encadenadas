const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const TURN_SECONDS = 25;
const rooms = new Map();

const base = s => s.toLowerCase().replace(/ñ/g, '\u0001')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0001/g, 'ñ');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Palabras encadenadas OK');
});
const wss = new WebSocketServer({ server });

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { players: [], words: [], current: null, deadline: 0, timer: null });
  return rooms.get(code);
}
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function lastLetter(r) {
  if (!r.words.length) return null;
  const w = base(r.words[r.words.length - 1].w);
  return w[w.length - 1];
}

function broadcast(r) {
  const left = Math.max(0, Math.round((r.deadline - Date.now()) / 1000));
  const state = {
    t: 'state',
    players: r.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    words: r.words.slice(-100),
    total: r.words.length,
    current: r.current,
    letter: lastLetter(r),
    left,
  };
  r.players.forEach(p => send(p.ws, { ...state, me: p.id }));
}

function nextTurn(r) {
  clearTimeout(r.timer);
  if (!r.players.length) { r.current = null; return; }
  const i = r.players.findIndex(p => p.id === r.current);
  r.current = r.players[(i + 1) % r.players.length].id;
  startTimer(r);
}

function startTimer(r) {
  clearTimeout(r.timer);
  r.deadline = Date.now() + TURN_SECONDS * 1000;
  r.timer = setTimeout(() => {
    const p = r.players.find(p => p.id === r.current);
    if (p) p.score -= 2;
    nextTurn(r);
    broadcast(r);
  }, TURN_SECONDS * 1000);
}

let nextId = 1;
wss.on('connection', ws => {
  let room = null, code = null, me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join' && !room) {
      code = String(m.room || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
      const name = String(m.name || '').trim().slice(0, 14);
      if (!code || !name) return send(ws, { t: 'err', msg: 'Nombre y sala obligatorios.' });
      room = getRoom(code);
      if (room.players.length >= 8) return send(ws, { t: 'err', msg: 'Sala llena (máx. 8).' });
      me = { id: 'p' + nextId++, name, score: 0, ws };
      room.players.push(me);
      if (!room.current) { room.current = me.id; startTimer(room); }
      return broadcast(room);
    }
    if (!room || !me) return;

    if (m.t === 'word') {
      if (room.current !== me.id) return send(ws, { t: 'err', msg: 'No es tu turno.' });
      const w = String(m.w || '').trim().toLowerCase();
      if (!/^[a-záéíóúüñ]{2,25}$/.test(w)) return send(ws, { t: 'err', msg: 'Usa solo letras (mínimo 2).' });
      const b = base(w), ll = lastLetter(room);
      if (ll && b[0] !== ll) return send(ws, { t: 'err', msg: `Debe empezar con «${ll.toUpperCase()}».` });
      if (room.words.some(x => base(x.w) === b)) return send(ws, { t: 'err', msg: 'Esa palabra ya se usó.' });
      room.words.push({ w, n: me.name });
      me.score += w.length;
      nextTurn(room);
      broadcast(room);
    }
    if (m.t === 'reset') {
      room.words = [];
      room.players.forEach(p => (p.score = 0));
      startTimer(room);
      broadcast(room);
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    const wasCurrent = room.current === me.id;
    const i = room.players.indexOf(me);
    room.players.splice(i, 1);
    if (!room.players.length) { clearTimeout(room.timer); rooms.delete(code); return; }
    if (wasCurrent) {
      room.current = room.players[i % room.players.length].id;
      startTimer(room);
    }
    broadcast(room);
  });
});

setInterval(() => wss.clients.forEach(ws => {
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false; ws.ping();
}), 30000);

server.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
