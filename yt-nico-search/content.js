// ============== utils ==============
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const text  = el => (el?.textContent||"").trim();
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

const CARD_RENDERERS = [
  'ytd-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-rich-item-renderer'
];

const BODY_FLAG_CLASSES = [
  ['hideShortsShelf', 'nico-hide-shorts-shelf'],
  ['hideAuxShelves',  'nico-hide-aux-shelves'],
  ['hideChannelBlock','nico-hide-channel-block']
];

const FILTER_ITEMS = [
  { label: '厳密一致（AND / "フレーズ"）', key: 'strictAnd' },
  { label: 'ライブのみ', key: 'liveOnly', exclusive: 'liveExclude' },
  { label: 'ライブ除外', key: 'liveExclude', exclusive: 'liveOnly' },
  { label: 'Shorts（単体カード）除外', key: 'shortsExclude' },
  { label: 'ショート棚を隠す', key: 'hideShortsShelf' },
  { label: 'おすすめ棚を隠す', key: 'hideAuxShelves' },
  { label: 'チャンネル塊を隠す', key: 'hideChannelBlock' }
];

function parseTokens(q){
  const out=[]; if(!q) return out;
  const re=/"([^"]+)"|(\S+)/g; let m;
  while((m=re.exec(q))) out.push((m[1]||m[2]).toLowerCase());
  return out;
}

// ============== prefs ==============
const STORE_KEY = "nico_filters_flags";
let prefs = {
  // カード絞り込み（元から欲しかった機能）
  strictAnd: false,   // タイトル+説明の AND/"phrase"
  liveOnly:  false,
  liveExclude: false,
  shortsExclude: true,

  // “棚”のCSS非表示（安定・既定ON）
  hideShortsShelf: true,
  hideAuxShelves:  true,
  hideChannelBlock: true
};

async function loadPrefs(){
  const s = await chrome.storage.sync.get(STORE_KEY);
  prefs = Object.assign({}, prefs, s[STORE_KEY]||{});
}
async function savePrefs(){
  await chrome.storage.sync.set({ [STORE_KEY]: prefs });
}

// ============== body flags（CSSに反映） ==============
function applyBodyFlags(){
  const body = document.body;
  if (!body) return;
  BODY_FLAG_CLASSES.forEach(([key, className]) => {
    body.classList.toggle(className, !!prefs[key]);
  });
}

// ============== カード絞り込み（非破壊 display:none） ==============
function isShortsCard(card){
  const a = card.querySelector('a#thumbnail, a#video-title, a.yt-simple-endpoint');
  const href = a?.getAttribute("href") || "";
  return href.startsWith("/shorts/");
}
function isLiveCard(card){
  // heavyなinnerTextは使わず、ライブラベルの典型DOMを軽く探す
  const badge = card.querySelector('ytd-badge-supported-renderer, .badge, .metadata-line');
  const s = (badge?.textContent || "").toLowerCase();
  return s.includes("ライブ") || s.includes("live");
}
function titlePlusDesc(card){
  const t = (card.querySelector('#video-title')?.textContent || "").toLowerCase();
  const d = (card.querySelector('#description-text, #description')?.textContent || "").toLowerCase();
  return t + "\n" + d;
}

function collectCards(){
  return new Set(
    CARD_RENDERERS.flatMap(selector => $$(selector))
  );
}

function shouldHideCard(card, tokens){
  if (prefs.shortsExclude && isShortsCard(card)) return true;

  if (prefs.liveOnly || prefs.liveExclude) {
    const live = isLiveCard(card);
    if (prefs.liveOnly && !live) return true;
    if (prefs.liveExclude && live) return true;
  }

  if (prefs.strictAnd && tokens.length) {
    const haystack = titlePlusDesc(card);
    return tokens.some(token => !haystack.includes(token));
  }

  return false;
}

function applyCardFilters(){
  const urlQuery = new URL(location.href).searchParams.get('search_query') || '';
  const tokens = prefs.strictAnd ? parseTokens(urlQuery) : [];

  collectCards().forEach(card => {
    card.classList.toggle('nico-hidden', shouldHideCard(card, tokens));
  });
}

// ============== 追加フィルタ（モーダル最下段） ==============
function findDialog(){
  return (
    $('ytd-search-filter-options-dialog-renderer') ||
    $('tp-yt-paper-dialog #contentWrapper') ||
    $('div[role="dialog"]')
  );
}

function findDialogContainer(dialog){
  return (
    dialog.querySelector('#sections, .sections, #content, .content, .scrollable-content') ||
    dialog
  );
}

function createFilterElement(section, item){
  const el = document.createElement('div');
  el.className = 'nico-filter-item';
  el.setAttribute('role', 'menuitemcheckbox');
  el.dataset.k = item.key;
  updateFilterElementState(el);

  el.textContent = item.label;
  el.addEventListener('click', async () => {
    prefs[item.key] = !prefs[item.key];
    if (item.exclusive && prefs[item.key]) prefs[item.exclusive] = false;
    await savePrefs();

    updateAllFilterElementStates(section);

    applyBodyFlags();
    applyCardFilters();
  });

  return el;
}

function updateFilterElementState(el){
  const key = el.dataset.k;
  el.setAttribute('aria-checked', String(!!prefs[key]));
}

function updateAllFilterElementStates(root = document){
  $$('.nico-filter-item[data-k]', root).forEach(updateFilterElementState);
}

function ensureDialogSection(){
  const dialog = findDialog();
  if (!dialog) return false;

  const existing = dialog.querySelector('.nico-section');
  if (existing) {
    updateAllFilterElementStates(existing);
    return true;
  }

  const container = findDialogContainer(dialog);

  const section = document.createElement('div');
  section.className = 'nico-section';
  section.innerHTML = `
    <div class="nico-title">追加フィルタ</div>
    <div class="nico-items" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
  `;

  const host = section.querySelector('.nico-items');
  FILTER_ITEMS
    .map(item => createFilterElement(section, item))
    .forEach(el => host.appendChild(el));

  container.appendChild(section);
  updateAllFilterElementStates(section);
  return true;
}

// ============== observers（軽量：1フレーム合流） ==============
let resultsObserver=null, dialogObserver=null, rafQueued=false;

function watchResults(){
  const host = $('#contents') || $('#primary') || document.body;
  if (!host) return;
  if (resultsObserver) resultsObserver.disconnect();
  resultsObserver = new MutationObserver(()=>{
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => {
      rafQueued = false;
      // カードだけを再評価（棚はCSSだけで制御）
      applyCardFilters();
    });
  });
  resultsObserver.observe(host, { childList:true, subtree:true });
}

function watchDialog(){
  if (dialogObserver) dialogObserver.disconnect();
  dialogObserver = new MutationObserver(()=> { ensureDialogSection(); });
  dialogObserver.observe(document.documentElement, { childList:true, subtree:true });
}

// ============== boot（SPA対応） ==============
async function boot(){
  await loadPrefs();
  applyBodyFlags();
  watchDialog();
  watchResults();
  applyCardFilters(); // 初回適用
  updateAllFilterElementStates();
}

(function init(){
  let last = location.pathname + location.search;
  new MutationObserver(async ()=>{
    const now = location.pathname + location.search;
    if (now === last) return;
    last = now;
    // 結果ページでなくても軽い処理しかしていないので、そのまま回す
    await loadPrefs();
    applyBodyFlags();
    applyCardFilters();
    updateAllFilterElementStates();
  }).observe(document.documentElement, { childList:true, subtree:true });

  boot();
})();
