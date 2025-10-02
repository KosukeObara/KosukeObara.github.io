// ============== utils ==============
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const text  = el => (el?.textContent||"").trim();
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

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
  const b = document.body;
  if (!b) return;
  b.classList.toggle('nico-hide-shorts-shelf', !!prefs.hideShortsShelf);
  b.classList.toggle('nico-hide-aux-shelves',  !!prefs.hideAuxShelves);
  b.classList.toggle('nico-hide-channel-block', !!prefs.hideChannelBlock);
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

function applyCardFilters(){
  const urlQ = new URL(location.href).searchParams.get("search_query") || "";
  const tokens = prefs.strictAnd ? parseTokens(urlQ) : [];

  const cards = new Set([
    ...$$('ytd-video-renderer'),
    ...$$('ytd-grid-video-renderer'),
    ...$$('ytd-rich-item-renderer')
  ]);

  cards.forEach(card=>{
    let hide = false;

    // Shorts カード除外
    if (prefs.shortsExclude && isShortsCard(card)) hide = true;

    // ライブのみ／除外
    if (!hide) {
      const live = isLiveCard(card);
      if (prefs.liveOnly && !live) hide = true;
      if (prefs.liveExclude && live) hide = true;
    }

    // 厳密一致（タイトル＋説明）
    if (!hide && prefs.strictAnd && tokens.length){
      const hay = titlePlusDesc(card);
      for (const t of tokens){ if (!hay.includes(t)) { hide = true; break; } }
    }

    card.classList.toggle('nico-hidden', hide);
  });
}

// ============== 追加フィルタ（モーダル最下段） ==============
function ensureDialogSection(){
  const dlg =
    $('ytd-search-filter-options-dialog-renderer') ||
    $('tp-yt-paper-dialog #contentWrapper') ||
    $('div[role="dialog"]');
  if (!dlg) return false;
  if (dlg.querySelector('.nico-section')) return true;

  const container =
    dlg.querySelector('#sections, .sections, #content, .content, .scrollable-content') || dlg;

  const sec = document.createElement('div');
  sec.className = 'nico-section';
  sec.innerHTML = `
    <div class="nico-title">追加フィルタ</div>
    <div class="nico-items" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
  `;
  const host = sec.querySelector('.nico-items');

  const make = (label, key, exclusiveWith=null) => {
    const el = document.createElement('div');
    el.className = 'nico-filter-item';
    el.setAttribute('role','menuitemcheckbox');
    el.setAttribute('aria-checked', String(!!prefs[key]));
    el.textContent = label;
    el.addEventListener('click', async ()=>{
      prefs[key] = !prefs[key];
      if (exclusiveWith && prefs[key]) prefs[exclusiveWith] = false; // 排他
      await savePrefs();
      el.setAttribute('aria-checked', String(!!prefs[key]));
      if (exclusiveWith) sec.querySelector(`[data-k="${exclusiveWith}"]`)
        ?.setAttribute('aria-checked', String(!!prefs[exclusiveWith]));
      // 反映
      applyBodyFlags();
      applyCardFilters();
    });
    el.dataset.k = key;
    return el;
  };

  // カード系（元の機能）
  host.append(
    make('厳密一致（AND / "フレーズ"）', 'strictAnd'),
    make('ライブのみ', 'liveOnly', 'liveExclude'),
    make('ライブ除外', 'liveExclude', 'liveOnly'),
    make('Shorts（単体カード）除外', 'shortsExclude')
  );

  // “棚”CSSフラグ
  host.append(
    make('ショート棚を隠す', 'hideShortsShelf'),
    make('おすすめ棚を隠す', 'hideAuxShelves'),
    make('チャンネル塊を隠す', 'hideChannelBlock')
  );

  container.appendChild(sec);
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
  }).observe(document.documentElement, { childList:true, subtree:true });

  boot();
})();
