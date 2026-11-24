const $ = selector => document.querySelector(selector);
const canvas = $('#board');
const context = canvas.getContext('2d');
const viewport = $('#viewport');
const stage = $('#stage');
const editor = $('#editor');
const fields = $('#editor-form').elements;
const fontFamilies = {
  sans: '"Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  serif: '"Batang", "AppleMyungjo", serif',
  mono: '"D2Coding", "Courier New", monospace',
};
const defaults = {
  font: 'sans', size: 16, ink: '#35283b', color: '#fff0bc',
  form: 'round', borderColor: '#cb9b55', border: 'solid',
};
const cardWidth = 176;
let board;
let pageId;
let edit;
let background;
let backgroundSource;
let paintedPage;

function activePage() {
  return board.pages.find(page => page.id === pageId);
}

async function refresh() {
  try {
    const query = board ? `?revision=${board.revision}` : '';
    const response = await fetch('/api/board' + query);
    if (response.status === 304) return;
    if (!response.ok) throw new Error('연결을 확인해 주세요.');
    acceptBoard(await response.json());
  } catch {
    if (!board) $('#count').textContent = '연결을 확인하는 중이에요.';
  }
}

async function save(change) {
  const response = await fetch('/api/board', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId, ...change }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function changeBoard(change, message = '저장했어요.') {
  try {
    const result = await save(change);
    if (change.action === 'addPage') pageId = result.pages.at(-1).id;
    acceptBoard(result);
    $('#status').textContent = message;
  } catch (error) {
    $('#status').textContent = error.message;
  }
}

function acceptBoard(result) {
  if (board && result.revision < board.revision) return;
  const previousTitle = board?.title;
  board = result;
  const input = $('#title-input');
  if (!previousTitle || input.value === previousTitle) input.value = board.title;
  render();
}

function render() {
  if (!activePage()) pageId = board.pages[0].id;
  const page = activePage();
  $('#title').textContent = board.title;
  $('#write').disabled = false;
  $('#settings-fields').disabled = false;
  $('#delete-page').disabled = board.pages.length === 1;
  $('#count').textContent = page.cards.length ? `카드 ${page.cards.length}장` : '첫 카드를 남겨 보세요.';
  $('#background-color').value = page.color;
  $('#remove-image').hidden = !page.image;
  for (const button of $('#shapes').children) {
    button.setAttribute('aria-pressed', button.dataset.shape === page.shape);
  }

  const pages = $('#pages');
  const rebuildPages = pages.children.length !== board.pages.length + 1 ||
    board.pages.some((item, index) => pages.children[index]?.dataset.pageId !== item.id);
  if (rebuildPages) {
    pages.replaceChildren(...board.pages.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button quiet';
      button.textContent = `페이지 ${index + 1}`;
      button.dataset.pageId = item.id;
      button.onclick = () => { pageId = item.id; render(); };
      return button;
    }));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'button quiet';
    add.textContent = '＋';
    add.setAttribute('aria-label', '페이지 추가');
    add.onclick = async () => {
      add.disabled = true;
      await changeBoard({ action: 'addPage' }, '페이지를 추가했어요.');
      add.disabled = false;
    };
    pages.append(add);
  }
  for (const button of pages.querySelectorAll('[data-page-id]')) {
    if (button.dataset.pageId === pageId) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const selectedTab = pages.querySelector('[aria-current="page"]');
  if (rebuildPages && selectedTab) {
    pages.scrollLeft = selectedTab.offsetLeft - pages.firstElementChild.offsetLeft;
  }
  if (page.image !== backgroundSource) {
    background = null;
    backgroundSource = page.image;
    if (page.image) {
      const image = new Image();
      image.onload = () => {
        if (backgroundSource === page.image) {
          background = image;
          $('#download').disabled = false;
          paint();
        }
      };
      image.onerror = () => {
        if (backgroundSource === page.image) {
          $('#download').disabled = false;
          $('#status').textContent = '배경 이미지를 표시할 수 없어요.';
        }
      };
      image.src = page.image;
    }
  }
  $('#download').disabled = Boolean(page.image && !background);
  paint();
}

function wrapText(text, font, width) {
  context.font = font;
  return text.split('\n').flatMap(paragraph => {
    const lines = [''];
    for (const character of paragraph) {
      const last = lines.length - 1;
      const next = lines[last] + character;
      if (lines[last] && context.measureText(next).width > width) lines.push(character.trimStart());
      else lines[last] = next;
    }
    return lines;
  });
}

function cardLayout(card, recipient = false) {
  const style = card.design;
  const font = `${style.size}px ${fontFamilies[style.font]}`;
  const nameSize = recipient ? style.size : Math.max(12, style.size - 3);
  const nameFont = `bold ${nameSize}px ${fontFamilies[style.font]}`;
  const name = wrapText(card.name, nameFont, cardWidth - 32);
  const paragraphs = recipient ? [] : card.message.split(/\n+/);
  const text = [...paragraphs.slice(0, 6), paragraphs.slice(6).join(' ')].filter(Boolean).join('\n');
  const message = recipient ? [] : wrapText(text, font, cardWidth - 32);
  const nameHeight = Math.ceil(nameSize * 1.35);
  const lineHeight = Math.ceil(style.size * 1.35);
  const height = Math.max(recipient ? 100 : 104,
    name.length * nameHeight + message.length * lineHeight + (recipient ? 46 : 36));
  return { card, recipient, font, nameFont, name, message, nameHeight, lineHeight, height };
}

function positions(shape, count) {
  const points = [];
  if (shape === 'spiral') {
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let x = 0;
    let y = 0;
    for (let run = 0; points.length < count; run++) {
      const [dx, dy] = directions[run % 4];
      for (let step = 0; step < 1 + Math.floor(run / 2); step++) {
        x += dx;
        y += dy;
        points.push([x, y]);
      }
    }
    return points.slice(0, count);
  }
  for (let row = -8; row <= 8; row++) {
    for (let column = -8; column <= 8; column++) {
      if (!row && !column) continue;
      const x = column + (Math.abs(row) % 2) * .5;
      const y = row;
      const angle = Math.atan2(y, x);
      const outline = shape === 'star'
        ? 1 + .29 * Math.cos(5 * (angle + Math.PI / 2))
        : 1.12 + .14 * Math.cos(6 * angle) - .17 * Math.sin(angle);
      const score = Math.hypot(x, shape === 'cloud' ? y * 1.4 : y) / outline;
      points.push({ x, y, score });
    }
  }
  return points.sort((a, b) => a.score - b.score).slice(0, count).map(({ x, y }) => [x, y]);
}

function drawCard(item) {
  const { x, y, height, card, recipient } = item;
  const style = card.design;
  context.save();
  context.beginPath();
  if (style.form === 'ticket') {
    const notch = 9;
    const right = x + cardWidth;
    const bottom = y + height;
    const mid = y + height / 2;
    context.moveTo(x, y);
    context.lineTo(right, y);
    context.lineTo(right, mid - notch);
    context.arc(right, mid, notch, -Math.PI / 2, Math.PI / 2, true);
    context.lineTo(right, bottom);
    context.lineTo(x, bottom);
    context.lineTo(x, mid + notch);
    context.arc(x, mid, notch, Math.PI / 2, -Math.PI / 2, true);
    context.closePath();
  } else {
    context.roundRect(x, y, cardWidth, height, style.form === 'square' ? 3 : 15);
  }
  context.shadowColor = '#43224922';
  context.shadowOffsetY = 4;
  context.shadowBlur = 10;
  context.fillStyle = style.color;
  context.fill();
  context.shadowColor = 'transparent';
  context.strokeStyle = style.borderColor;
  context.lineWidth = 2;
  if (style.border === 'dashed') context.setLineDash([6, 4]);
  if (style.border === 'dotted') {
    context.setLineDash([1, 4]);
    context.lineCap = 'round';
  }
  if (style.border !== 'none') context.stroke();
  context.fillStyle = style.ink;
  context.textBaseline = 'top';
  context.textAlign = recipient ? 'center' : 'left';
  const textX = recipient ? x + cardWidth / 2 : x + 16;
  let textY = recipient ? y + (height - item.name.length * item.nameHeight) / 2 + 7 : y + 14;
  if (recipient) {
    context.font = `12px ${fontFamilies.sans}`;
    context.fillText('TO.', textX, textY - 19);
  }
  context.font = item.nameFont;
  for (const line of item.name) {
    context.fillText(line, textX, textY);
    textY += item.nameHeight;
  }
  context.font = item.font;
  textY += 6;
  for (const line of item.message) {
    context.fillText(line, textX, textY);
    textY += item.lineHeight;
  }
  context.restore();
}

function paint() {
  const page = activePage();
  const recipient = cardLayout(board.recipient, true);
  const cards = page.cards.map(card => cardLayout(card));
  const rowHeight = Math.max(recipient.height, ...cards.map(item => item.height)) + 26;
  const coords = [[0, 0], ...positions(page.shape, cards.length)];
  const width = Math.max(870, 2 * Math.max(...coords.map(([x]) => Math.abs(x) * 194 + cardWidth / 2 + 28)));
  const height = Math.max(500, 2 * Math.max(...[recipient, ...cards].map((item, i) =>
    Math.abs(coords[i][1]) * rowHeight + item.height / 2 + 28)));
  const recenter = canvas.width !== width || canvas.height !== height || pageId !== paintedPage;
  paintedPage = pageId;
  canvas.width = width;
  canvas.height = height;
  stage.style.width = `max(100%, ${Math.ceil(width * .65)}px)`;
  context.fillStyle = page.color;
  context.fillRect(0, 0, width, height);
  if (background) {
    const scale = Math.max(width / background.width, height / background.height);
    const imageWidth = background.width * scale;
    const imageHeight = background.height * scale;
    context.drawImage(background, (width - imageWidth) / 2, (height - imageHeight) / 2, imageWidth, imageHeight);
  } else {
    context.fillStyle = '#80529734';
    for (let y = 12; y < height; y += 23) {
      for (let x = 12; x < width; x += 23) context.fillRect(x, y, 2, 2);
    }
    if (!cards.length) {
      context.strokeStyle = '#80529742';
      context.setLineDash([3, 6]);
      for (const radius of [110, 174]) {
        context.beginPath();
        context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
        context.stroke();
      }
      context.setLineDash([]);
    }
  }
  const buttons = [recipient, ...cards].map((item, i) => {
    item.x = width / 2 + coords[i][0] * 194 - cardWidth / 2;
    item.y = height / 2 + coords[i][1] * rowHeight - item.height / 2;
    drawCard(item);
    const button = document.createElement('button');
    button.className = 'card-button';
    button.dataset.cardId = item.recipient ? 'recipient' : item.card.id;
    button.style.cssText = `left:${item.x / width * 100}%;top:${item.y / height * 100}%;width:${cardWidth / width * 100}%;height:${item.height / height * 100}%`;
    button.setAttribute('aria-label', item.recipient
      ? `받는 사람 ${item.card.name} 카드 꾸미기`
      : `${item.card.name} 카드 보기 및 꾸미기`);
    button.onclick = () => openEditor(item.recipient ? 'recipient' : 'editCard', item.card);
    return button;
  });
  const focusedCard = document.activeElement?.dataset.cardId;
  $('#card-buttons').replaceChildren(...buttons);
  if (focusedCard) buttons.find(button => button.dataset.cardId === focusedCard)?.focus({ preventScroll: true });
  if (recenter) centerBoard();
}

function centerBoard() {
  viewport.scrollLeft = (stage.offsetWidth - viewport.clientWidth) / 2;
  viewport.scrollTop = (stage.offsetHeight - viewport.clientHeight) / 2;
}

function openEditor(action, card = {}) {
  edit = { action, cardId: card.id, pageId };
  const editingCard = action === 'editCard';
  $('#editor-title').textContent = { createCard: '롤링페이퍼 쓰기', editCard: '카드 꾸미기', recipient: '받는 사람 꾸미기' }[action];
  $('#name-label').textContent = action === 'recipient' ? '받는 사람 이름' : '쓴 사람 이름';
  $('#message-field').hidden = action === 'recipient';
  fields.name.value = card.name || '';
  fields.name.readOnly = editingCard;
  fields.message.value = card.message || '';
  fields.message.required = action === 'createCard';
  fields.message.readOnly = editingCard;
  for (const [key, value] of Object.entries(card.design || defaults)) fields[key].value = value;
  $('#editor-error').textContent = '';
  preview();
  editor.showModal();
  (editingCard ? fields.font : fields.name).focus();
}

function readDesign() {
  return Object.fromEntries(Object.keys(defaults).map(key => [key, fields[key].value]));
}

function preview() {
  const design = readDesign();
  const sample = $('#card-preview');
  sample.textContent = fields.name.value || (edit.action === 'recipient' ? '받는 사람' : '쓴 사람 이름');
  Object.assign(sample.style, {
    color: design.ink, background: design.color, fontFamily: fontFamilies[design.font],
    fontSize: `${design.size}px`, border: `2px ${design.border} ${design.borderColor}`,
    borderRadius: { round: '15px', square: '3px', ticket: '0' }[design.form],
  });
}

$('#editor-form').oninput = preview;
$('#editor-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('#save-card');
  button.disabled = true;
  try {
    acceptBoard(await save({
      ...edit, name: fields.name.value, message: fields.message.value, design: readDesign(),
    }));
    editor.close();
    $('#status').textContent = '카드를 저장했어요.';
  } catch (error) {
    $('#editor-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('#close-editor').onclick = () => editor.close();
$('#write').onclick = () => openEditor('createCard');
$('#recipient').onclick = () => openEditor('recipient', board.recipient);
$('#title-form').onsubmit = event => {
  event.preventDefault();
  const input = $('#title-input');
  input.value = input.value.trim();
  changeBoard({ action: 'title', title: input.value });
};
$('#shapes').onclick = event => {
  const button = event.target.closest('[data-shape]');
  if (button) changeBoard({ action: 'shape', shape: button.dataset.shape });
};
$('#delete-page').onclick = () => {
  if (confirm('이 페이지와 페이지 안의 카드가 모두 지워져요. 삭제할까요?')) {
    changeBoard({ action: 'deletePage' }, '페이지를 삭제했어요.');
  }
};
$('#background-color').onchange = event => changeBoard({ action: 'background', color: event.target.value });
$('#remove-image').onclick = () => changeBoard({ action: 'background', image: '' });
$('#background-image').onchange = async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const targetPage = pageId;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const thumbnail = document.createElement('canvas');
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    thumbnail.width = Math.max(1, Math.round(image.width * scale));
    thumbnail.height = Math.max(1, Math.round(image.height * scale));
    thumbnail.getContext('2d').drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
    await changeBoard({ action: 'background', pageId: targetPage, image: thumbnail.toDataURL('image/webp', .82) });
  } catch {
    $('#status').textContent = '이미지 파일을 읽을 수 없어요.';
  } finally {
    URL.revokeObjectURL(url);
  }
};
$('#download').onclick = () => {
  const output = document.createElement('canvas');
  const font = `bold 30px ${fontFamilies.sans}`;
  const lines = wrapText(board.title, font, canvas.width - 60);
  const headerHeight = lines.length * 39 + 34;
  output.width = canvas.width;
  output.height = canvas.height + headerHeight;
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, output.width, headerHeight);
  ctx.fillStyle = '#302237';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((line, index) => ctx.fillText(line, output.width / 2, 17 + index * 39));
  ctx.drawImage(canvas, 0, headerHeight);
  const filename = `${board.title.replace(/[\\/:*?"<>|]/g, '_')}-${board.pages.findIndex(page => page.id === pageId) + 1}.png`;
  output.toBlob(blob => {
    if (!blob) {
      $('#status').textContent = '이미지 파일을 만들 수 없어요.';
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
};
$('#share').onclick = async () => {
  const url = location.origin;
  try {
    await navigator.clipboard.writeText(url);
    $('#status').textContent = '링크를 복사했어요.';
  } catch {
    prompt('이 주소를 복사해 공유하세요.', url);
  }
};
window.addEventListener('resize', centerBoard);
refresh();
setInterval(refresh, 2000);
