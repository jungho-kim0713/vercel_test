const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const BOARD_ID = 'main';

const newPage = () => ({ id: randomUUID(), shape: 'spiral', color: '#fbf8fd', image: '', cards: [] });
const initialBoard = () => ({
  revision: 0,
  title: '우리 반 롤링페이퍼',
  recipient: { name: '받는 사람', design: design({ color: '#f0dafa', borderColor: '#b47ac2', size: 24 }) },
  pages: [newPage()],
});

let initialized = false;

async function ensureTable() {
  if (initialized) return;
  await sql`
    CREATE TABLE IF NOT EXISTS rolling_boards (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  initialized = true;
}

async function loadBoard() {
  await ensureTable();
  const rows = await sql`SELECT data FROM rolling_boards WHERE id = ${BOARD_ID}`;
  if (rows.length > 0) {
    return rows[0].data;
  }
  const init = initialBoard();
  await sql`
    INSERT INTO rolling_boards (id, data)
    VALUES (${BOARD_ID}, ${JSON.stringify(init)}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;
  const check = await sql`SELECT data FROM rolling_boards WHERE id = ${BOARD_ID}`;
  return check.length > 0 ? check[0].data : init;
}

async function saveBoard(next) {
  await ensureTable();
  await sql`
    INSERT INTO rolling_boards (id, data, updated_at)
    VALUES (${BOARD_ID}, ${JSON.stringify(next)}::jsonb, NOW())
    ON CONFLICT (id)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `;
}

const assets = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
};

function choice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function color(value, fallback) {
  return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : fallback;
}

function design(value = {}) {
  value = value || {};
  const size = Number(value.size);
  return {
    font: choice(value.font, ['sans', 'serif', 'mono'], 'sans'),
    size: Number.isFinite(size) ? Math.min(28, Math.max(12, size)) : 16,
    ink: color(value.ink, '#35283b'),
    color: color(value.color, '#fff0bc'),
    form: choice(value.form, ['round', 'square', 'ticket'], 'round'),
    borderColor: color(value.borderColor, '#cb9b55'),
    border: choice(value.border, ['solid', 'dashed', 'dotted', 'none'], 'solid'),
  };
}

function required(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
    throw new Error(`내용을 1~${limit}자로 입력해 주세요.`);
  }
  return value.trim();
}

function update(next, change) {
  if (change.action === 'title') {
    next.title = required(change.title, 45);
    return;
  }
  if (change.action === 'recipient') {
    next.recipient = { name: required(change.name, 25), design: design(change.design) };
    return;
  }
  if (change.action === 'addPage') {
    if (next.pages.length >= 12) throw new Error('페이지는 최대 12개까지 만들 수 있어요.');
    next.pages.push(newPage());
    return;
  }
  const page = next.pages.find(item => item.id === change.pageId);
  if (!page) throw new Error('이 페이지가 이미 삭제되었어요.');

  switch (change.action) {
    case 'deletePage':
      if (next.pages.length === 1) throw new Error('페이지를 하나 이상 남겨 주세요.');
      next.pages = next.pages.filter(item => item !== page);
      break;
    case 'shape':
      page.shape = choice(change.shape, ['spiral', 'star', 'cloud'], 'spiral');
      break;
    case 'background':
      page.color = color(change.color, page.color);
      if (change.image !== undefined) {
        if (
          typeof change.image !== 'string' ||
          change.image.length > 1_000_000 ||
          (change.image && !/^data:image\/(jpeg|png|webp);base64,[a-z\d+/]+={0,2}$/i.test(change.image))
        ) {
          throw new Error('배경 이미지를 읽을 수 없어요.');
        }
        page.image = change.image;
      }
      break;
    case 'createCard':
      if (page.cards.length >= 40) throw new Error('이 페이지에는 카드가 가득 찼어요. 새 페이지를 추가해 주세요.');
      page.cards.push({
        id: randomUUID(),
        name: required(change.name, 25),
        message: required(change.message, 180),
        design: design(change.design),
      });
      break;
    case 'editCard': {
      const card = page.cards.find(item => item.id === change.cardId);
      if (!card) throw new Error('이 카드를 찾을 수 없어요.');
      card.design = design(change.design);
      break;
    }
    default:
      throw new Error('알 수 없는 요청이에요.');
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
    const [file, type] = assets[url.pathname];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
    return;
  }

  if (url.pathname === '/api/board' && req.method === 'GET') {
    try {
      const board = await loadBoard();
      if (url.searchParams.get('revision') === String(board.revision)) {
        res.writeHead(304, { 'Cache-Control': 'no-store' }).end();
      } else {
        json(res, 200, board);
      }
    } catch (error) {
      console.error(error);
      json(res, 500, { error: '데이터를 불러오지 못했어요.' });
    }
    return;
  }

  if (url.pathname !== '/api/board' || req.method !== 'POST') {
    json(res, 404, { error: '페이지를 찾을 수 없어요.' });
    return;
  }

  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    json(res, 415, { error: 'JSON 요청만 받을 수 있어요.' });
    return;
  }

  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 1_050_000) {
        json(res, 413, { error: '파일이 너무 커요.' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    return;
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    json(res, 400, { error: '잘못된 요청 형식이에요.' });
    return;
  }

  try {
    const current = await loadBoard();
    const next = structuredClone(current);
    update(next, body);
    next.revision++;
    await saveBoard(next);
    json(res, 200, next);
  } catch (error) {
    if (error.message && !error.code) {
      json(res, 400, { error: error.message });
    } else {
      console.error(error);
      json(res, 500, { error: '저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
    }
  }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', function () {
  console.log(`http://localhost:${this.address().port}`);
});
