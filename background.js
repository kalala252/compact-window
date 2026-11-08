// コンパクト表示 = タブを type: "popup" のウィンドウへ移す。
// popup ウィンドウにはタブバーと編集可能なアドレスバーが無いため、その分だけ表示領域が広がる。
// 他のウィンドウには一切影響しない。

const KEY = "compactWindows"; // { [popupWindowId]: { windowId, index, bounds, state } }
const MENU_ID = "toggle-compact";

async function getMap() {
  const { [KEY]: map = {} } = await chrome.storage.session.get(KEY);
  return map;
}

async function setMap(map) {
  await chrome.storage.session.set({ [KEY]: map });
}

function boundsOf(win) {
  return { left: win.left, top: win.top, width: win.width, height: win.height };
}

async function toggle(tab) {
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
  }
  const win = await chrome.windows.get(tab.windowId);
  const map = await getMap();

  if (map[win.id]) {
    await restore(win, tab, map);
  } else if (win.type === "normal") {
    await compact(win, tab, map);
  }
}

async function compact(win, tab, map) {
  const info = {
    windowId: win.id,
    index: tab.index,
    bounds: boundsOf(win),
    state: win.state,
  };

  // 元ウィンドウと同じ位置・サイズで popup を作る（中身の表示領域はツールバー分だけ大きくなる）
  const popup = await chrome.windows.create({
    tabId: tab.id,
    type: "popup",
    focused: true,
    ...info.bounds,
  });

  if (win.state === "fullscreen" || win.state === "maximized") {
    await chrome.windows.update(popup.id, { state: win.state });
  }

  map[popup.id] = info;
  await setMap(map);
}

async function restore(popupWin, tab, map) {
  const info = map[popupWin.id];
  delete map[popupWin.id];
  await setMap(map);

  // fullscreen のままだと移動に失敗することがあるので先に解除する
  if (popupWin.state === "fullscreen") {
    await chrome.windows.update(popupWin.id, { state: "normal" });
  }

  let target = null;
  try {
    target = await chrome.windows.get(info.windowId);
    if (target.type !== "normal") target = null;
  } catch {
    // 元ウィンドウが閉じられている（タブが1枚だけだった場合など）
  }

  // 1. 元のウィンドウの元の位置へ戻す
  if (target) {
    try {
      await chrome.tabs.move(tab.id, { windowId: target.id, index: info.index });
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(target.id, { focused: true });
      return;
    } catch (e) {
      console.warn("tabs.move failed:", e);
    }
  }

  // 2. 新しい通常ウィンドウとして戻す（ページの状態は保たれる）
  try {
    const created = await chrome.windows.create({
      tabId: tab.id,
      type: "normal",
      focused: true,
      ...info.bounds,
    });
    if (info.state === "fullscreen" || info.state === "maximized") {
      await chrome.windows.update(created.id, { state: info.state });
    }
    return;
  } catch (e) {
    console.warn("windows.create with tabId failed:", e);
  }

  // 3. 最終手段: URL を開き直して popup を閉じる（スクロール位置などは失われる）
  if (target) {
    await chrome.tabs.create({ windowId: target.id, index: info.index, url: tab.url, active: true });
    await chrome.windows.update(target.id, { focused: true });
  } else {
    await chrome.windows.create({ url: tab.url, type: "normal", focused: true, ...info.bounds });
  }
  await chrome.windows.remove(popupWin.id);
}

// ツールバーのボタン（通常ウィンドウでのみ表示される）
chrome.action.onClicked.addListener((tab) => toggle(tab));

// キーボードショートカット（popup ウィンドウでも効くので、戻すときはこれを使う）
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-compact") toggle(tab);
});

// 右クリックメニュー（popup ウィンドウ内でも使える）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "コンパクト表示の切り替え",
    contexts: ["page", "frame", "selection", "link", "image", "video", "audio"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) toggle(tab);
});

// popup ウィンドウを直接閉じたときは記録を消す
chrome.windows.onRemoved.addListener(async (windowId) => {
  const map = await getMap();
  if (map[windowId]) {
    delete map[windowId];
    await setMap(map);
  }
});
