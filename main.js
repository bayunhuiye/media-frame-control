'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, TFile, MarkdownView } = obsidian;

const PLUGIN_ID = 'media-frame-control';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_SETTINGS = {
  enabled: true,
  gifEnabled: true,
  videoEnabled: true,
  speeds: '0.1,0.25,0.5,0.75,1,1.25,1.5,2,2.5,3',
  defaultSpeed: 1,
  loopVideo: true,
  maxFrames: 400,
  maxFileMB: 80,
  deleteOnKey: true,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeURISafe(s) {
  try {
    return decodeURI(String(s || ''));
  } catch (e) {
    try {
      return decodeURIComponent(String(s || ''));
    } catch (e2) {
      return String(s || '');
    }
  }
}

// 朴素的单色图标：用 currentColor，跟着文字颜色走，不带任何彩色
const ICON_PATHS = {
  prev: 'M10 3.5 5.5 8l4.5 4.5',
  next: 'M6 3.5 10.5 8 6 12.5',
  play: 'M6 3.8 11.6 8 6 12.2z',
  pause: 'M6.2 3.8h1.5v8.4H6.2zM8.6 3.8h1.5v8.4H8.6z',
  close: 'M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8',
  loop: 'M3.2 8a4.8 4.8 0 0 1 4.8-4.8h2.6M12.8 8a4.8 4.8 0 0 1-4.8 4.8H5.4M9.2 1.6 11.4 3.2 9.2 4.8M6.8 14.4 4.6 12.8 6.8 11.2',
};

function makeIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('class', 'mfc-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const solid = kind === 'play' || kind === 'pause';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[kind] || '');
  path.setAttribute('fill', solid ? 'currentColor' : 'none');
  if (!solid) {
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.appendChild(path);
  return svg;
}

// 正文里所有嵌入，按出现位置排序。
// 不拿链接文本反推，而是把所有嵌入都收集起来，再逐个解析成文件做比对 ——
// 这样 ![[clip.mp4]]、![[目录/clip.mp4]]、![](路径) 三种写法都能认。
function collectEmbeds(text) {
  const out = [];

  const wiki = /!\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = wiki.exec(text))) {
    let inner = m[1];
    // ![[a.png|300]] / ![[a.png|别名]]：竖线后面是尺寸或别名
    const bar = inner.indexOf('|');
    if (bar >= 0) inner = inner.slice(0, bar);
    // 去掉 #标题 或 #^块
    inner = inner.split('#')[0].trim();
    out.push({ from: m.index, to: m.index + m[0].length, link: inner, raw: m[0] });
  }

  const md = /!\[[^\]\n]*\]\(\s*([^)\n]+?)\s*\)/g;
  while ((m = md.exec(text))) {
    let target = m[1].trim();
    // 去掉 markdown 的 "title"
    target = target.replace(/\s+("[^"]*"|'[^']*')$/, '').trim();
    if (!target || /^(https?:|data:|mailto:)/i.test(target)) continue;
    let decoded = target;
    try {
      decoded = decodeURI(target);
    } catch (e) {
      /* 保持原样 */
    }
    out.push({ from: m.index, to: m.index + m[0].length, link: decoded, raw: m[0] });
  }

  return out.sort((a, b) => a.from - b.from);
}

// 把正文里的链接文本解析成库里的文件
function resolveLinkToFile(app, link, sourcePath) {
  if (!link) return null;
  const tries = [];
  const push = (v) => {
    if (v && tries.indexOf(v) === -1) tries.push(v);
  };
  push(link);
  try {
    push(decodeURI(link));
  } catch (e) {
    /* ignore */
  }
  // 链接里可能带 ./ 或反斜杠
  push(String(link).replace(/^\.\//, '').replace(/\\/g, '/'));

  for (const t of tries) {
    if (app.metadataCache && typeof app.metadataCache.getFirstLinkpathDest === 'function') {
      try {
        const f = app.metadataCache.getFirstLinkpathDest(t, sourcePath);
        if (f instanceof TFile) return f;
      } catch (e) {
        /* ignore */
      }
    }
    try {
      const f = app.vault.getAbstractFileByPath(t);
      if (f instanceof TFile) return f;
    } catch (e) {
      /* ignore */
    }
  }

  // 只写了文件名时，按同名文件找，优先同目录
  const name = String(link).split('/').pop().split('?')[0];
  if (!name) return null;
  let all = [];
  try {
    all = app.vault.getFiles() || [];
  } catch (e) {
    all = [];
  }
  const same = all.filter((f) => f.name === name);
  if (!same.length) return null;
  if (same.length === 1) return same[0];
  const srcDir = sourcePath && sourcePath.indexOf('/') >= 0 ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const sameDir = same.find((f) => (f.parent ? f.parent.path : '') === (srcDir || '/'));
  return sameDir || same[0];
}

class GifPlayer {
  constructor(plugin, img, file, hint) {
    this.plugin = plugin;
    this.img = img;
    this.file = file;
    this.hint = hint || '';
    this.decoder = null;
    this.count = 0;
    this.index = 0;
    this.playing = false;
    this.destroyed = false;
    this.renderToken = 0;
    this.durations = [];
    this.canvas = null;
    this.ctx = null;
    this.wrap = null;
    this.bar = null;
    this.label = null;
    this.playBtn = null;
  }

  async mount() {
    if (typeof ImageDecoder === 'undefined') {
      new Notice('当前环境不支持 GIF 逐帧解码');
      return false;
    }
    try {
      if (ImageDecoder.isTypeSupported && !ImageDecoder.isTypeSupported('image/gif')) {
        new Notice('当前环境不支持 GIF 解码');
        return false;
      }
    } catch (e) {
      /* 老版本没有这个静态方法，忽略 */
    }

    if (!this.file) return false;
    if (this.destroyed) return false;

    const sizeLimit = (Number(this.plugin.settings.maxFileMB) || 80) * 1024 * 1024;
    if (this.file.stat && this.file.stat.size > sizeLimit) {
      new Notice(`GIF 超过 ${this.plugin.settings.maxFileMB}MB，已跳过逐帧解析`);
      return false;
    }

    let buf;
    try {
      buf = await this.plugin.app.vault.adapter.readBinary(this.file.path);
    } catch (e) {
      new Notice('读取 GIF 失败');
      return false;
    }
    if (this.destroyed) return false;

    try {
      this.decoder = new ImageDecoder({ data: buf, type: 'image/gif' });
      await this.decoder.tracks.ready;
      if (this.destroyed) return false;
      const track = this.decoder.tracks.selectedTrack;
      this.count = track ? track.frameCount : 0;
    } catch (e) {
      new Notice('GIF 解析失败，可能文件已损坏');
      return false;
    }

    if (this.destroyed) return false;
    if (!this.count) {
      new Notice('这个 GIF 没有可解析的帧');
      return false;
    }

    const maxFrames = Number(this.plugin.settings.maxFrames) || 400;
    if (this.count > maxFrames) {
      new Notice(`GIF 共 ${this.count} 帧，超过上限 ${maxFrames}，已跳过逐帧解析`);
      return false;
    }

    // 画布塞进 DOM 之前先确认原图还在页面上
    if (!this.img.isConnected || !this.img.parentElement) {
      return false;
    }

    this.buildDom();
    if (this.destroyed) {
      // 建 DOM 期间被作废
      if (this.wrap && this.wrap.parentElement) this.wrap.remove();
      this.img.style.display = '';
      return false;
    }
    await this.render(0);
    if (this.destroyed) return false;
    // 默认不暂停：进来就继续放，想定格再点暂停
    this.play();
    return true;
  }

  // 控制条叠在画面内部（浮层），不额外占一行
  buildDom() {
    const wrap = document.createElement('div');
    wrap.className = 'mfc-gif-wrap';
    wrap.tabIndex = 0;
    wrap.__mfcFile = this.file;

    const bar = document.createElement('div');
    bar.className = 'mfc-bar';

    const prev = document.createElement('button');
    prev.className = 'mfc-btn';
    prev.appendChild(makeIcon('prev'));
    prev.title = '上一帧';
    prev.type = 'button';

    const play = document.createElement('button');
    play.className = 'mfc-btn';
    play.appendChild(makeIcon('play'));
    play.title = '播放 / 暂停';
    play.type = 'button';

    const next = document.createElement('button');
    next.className = 'mfc-btn';
    next.appendChild(makeIcon('next'));
    next.title = '下一帧';
    next.type = 'button';

    const label = document.createElement('span');
    label.className = 'mfc-label';

    const close = document.createElement('button');
    close.className = 'mfc-btn mfc-close';
    close.appendChild(makeIcon('close'));
    close.title = '退出逐帧模式';
    close.type = 'button';

    bar.appendChild(prev);
    bar.appendChild(play);
    bar.appendChild(next);
    bar.appendChild(label);
    bar.appendChild(close);

    const canvas = document.createElement('canvas');
    canvas.className = 'mfc-canvas';
    canvas.__mfcFile = this.file;
    // 逐帧后原 img 被隐藏、且是直接子节点，删掉整行后 DOM 会被重渲染，
    // 这里记下“正文里该怎么写”的线索，删除时用来精确命中那一条嵌入
    wrap.__mfcHint = this.hint || '';

    wrap.appendChild(canvas);
    wrap.appendChild(bar);

    this.img.style.display = 'none';
    this.img.parentElement.insertBefore(wrap, this.img.nextSibling);

    this.wrap = wrap;
    this.bar = bar;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.label = label;
    this.playBtn = play;

    // 控制条是浮层：点它不要顺带触发画布上的选中/播放行为
    bar.addEventListener('click', (e) => e.stopPropagation());

    prev.addEventListener('click', (e) => {
      e.stopPropagation();
      this.prev();
    });
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      this.next();
    });
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.destroy();
    });

    // 逐帧模式下，画布本身也能选中并接受 Delete
    canvas.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.selectMedia(wrap);
    });
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.selectMedia(wrap);
    });

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.clearSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.plugin.handleDeleteKey(e, wrap, this.file);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.prev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.next();
      } else if (e.key === ' ') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  async render(i) {
    if (!this.decoder || this.destroyed) return;
    const idx = Math.max(0, Math.min(i, this.count - 1));

    // 用 token 丢弃过期结果：连点时只有最后一次生效
    const token = ++this.renderToken;
    this.index = idx;
    this.updateLabel();

    try {
      const result = await this.decoder.decode({ frameIndex: idx });
      if (token !== this.renderToken || this.destroyed) {
        try {
          if (result && result.image) result.image.close();
        } catch (e) {
          /* ignore */
        }
        return;
      }
      const frame = result.image;
      if (!frame) return;
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
      }
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(frame, 0, 0);
      const ms = frame.duration ? frame.duration / 1000 : 100;
      this.durations[idx] = Math.max(20, ms);
      frame.close();
    } catch (e) {
      // 旧帧结果过期时解码可能已被关闭，这种情况不算错误
      if (token !== this.renderToken || this.destroyed) return;
      this.pause();
      new Notice('GIF 帧解码失败');
    }
  }

  updateLabel() {
    if (this.label) this.label.textContent = `${this.index + 1} / ${this.count}`;
  }

  updatePlayBtn() {
    if (!this.playBtn) return;
    const want = this.playing ? 'pause' : 'play';
    const cur = this.playBtn.getAttribute('data-mfc-icon');
    if (cur === want) return;
    this.playBtn.setAttribute('data-mfc-icon', want);
    while (this.playBtn.firstChild) this.playBtn.removeChild(this.playBtn.firstChild);
    this.playBtn.appendChild(makeIcon(want));
  }

  async prev() {
    this.pause();
    await this.render(this.index - 1);
  }

  async next() {
    this.pause();
    await this.render(this.index + 1);
  }

  async toggle() {
    if (this.playing) this.pause();
    else await this.play();
  }

  async play() {
    if (this.playing) return;
    this.playing = true;
    this.updatePlayBtn();
    while (this.playing && !this.destroyed) {
      const at = this.index;
      await this.render(at);
      if (!this.playing || this.destroyed) break;
      const wait = this.durations[at] || 100;
      await sleep(wait);
      if (!this.playing || this.destroyed) break;
      this.index = at + 1 >= this.count ? 0 : at + 1;
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.updatePlayBtn();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playing = false;
    try {
      if (this.decoder) this.decoder.close();
    } catch (e) {
      /* ignore */
    }
    this.decoder = null;
    this.canvas = null;
    this.ctx = null;
    this.durations = [];
    if (this.wrap && this.wrap.parentElement) this.wrap.remove();
    this.wrap = null;
    if (this.img) this.img.style.display = '';
    if (typeof this.onDestroy === 'function') this.onDestroy();
  }
}

class MediaFrameControl extends Plugin {
  async onload() {
    await this.loadSettings();
    this.players = new WeakMap();
    this.scanTimer = null;
    this.observer = null;
    this.selectedEl = null;

    this.addSettingTab(new MfcSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.startObserver();
      this.scan(document.body);
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleScan()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleScan()));
  }

  onunload() {
    this.unbindSelectionDismiss();
    if (this.observer) this.observer.disconnect();
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.pendingPlayer) {
      this.pendingPlayer.destroy();
      this.pendingPlayer = null;
    }
    if (this.activePlayer) {
      this.activePlayer.destroy();
      this.activePlayer = null;
    }
  }

  scheduleScan() {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      const roots = this.pendingRoots || [];
      this.pendingRoots = [];
      if (roots.length) {
        for (const r of roots) {
          if (r.isConnected) this.scan(r);
        }
      } else {
        this.scan(document.body);
      }
    }, 150);
  }

  startObserver() {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => {
      const roots = [];
      for (const r of records) {
        if (!r.addedNodes || !r.addedNodes.length) continue;
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) roots.push(n);
        }
      }
      if (!roots.length) return;
      // 只扫描新插入的节点，避免每次输入都全库重扫
      this.pendingRoots = (this.pendingRoots || []).concat(roots);
      this.scheduleScan();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  scan(root) {
    if (!this.settings.enabled) return;
    if (!root) return;

    // querySelectorAll 只查后代，新增节点本身就是 img/video 时会被漏掉
    const imgs = [];
    if (this.settings.gifEnabled) {
      if (root.tagName === 'IMG') imgs.push(root);
      imgs.push.apply(imgs, root.querySelectorAll('img'));
      for (const img of imgs) {
        if (img.dataset.mfcGif) continue;
        if (!this.looksLikeGif(img)) continue;
        img.dataset.mfcGif = '1';
        this.attachGif(img);
      }
    }

    if (this.settings.videoEnabled) {
      const videos = [];
      if (root.tagName === 'VIDEO') videos.push(root);
      videos.push.apply(videos, root.querySelectorAll('video'));
      for (const video of videos) {
        if (video.dataset.mfcVideo) continue;
        video.dataset.mfcVideo = '1';
        this.attachVideo(video);
      }
    }

    this.cleanupDetached();
  }

  // Obsidian 重渲染会丢掉我们插入的节点，留下悬空的解码器
  cleanupDetached() {
    const p = this.activePlayer || this.pendingPlayer;
    if (p && p.img && !p.img.isConnected) {
      p.destroy();
      this.activePlayer = null;
      this.pendingPlayer = null;
    }
  }

  looksLikeGif(img) {
    const src = img.getAttribute('src') || '';
    if (/\.gif(\?|#|$)/i.test(src)) return true;
    const alt = img.getAttribute('alt') || '';
    return /\.gif$/i.test(alt.trim());
  }

  resolveFile(el) {
    if (el && el.__mfcFile instanceof TFile) return el.__mfcFile;

    const alt = (el.getAttribute('alt') || '').trim();
    const src = el.getAttribute('src') || '';

    let active = null;
    try {
      if (this.app.workspace && typeof this.app.workspace.getActiveFile === 'function') {
        active = this.app.workspace.getActiveFile();
      }
    } catch (e) {
      active = null;
    }
    const sourcePath = active && active.path ? active.path : '';

    const candidates = [];

    // 1) app:// 路径里能拿到库内相对路径就直接用
    if (src.startsWith('app://')) {
      try {
        const u = new URL(src);
        const p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
        if (p) candidates.push(p);
      } catch (e) {
        /* ignore */
      }
    }
    if (alt) candidates.push(alt);

    // 2) 交给 Obsidian 的链接解析，它会按「最短路径」规则处理同名文件
    for (const c of candidates) {
      const f = resolveLinkToFile(this.app, c, sourcePath);
      if (f) return f;
    }

    // 3) 同名兜底：优先取与当前笔记同目录的那一个，而不是随便第一个
    const name = (alt || src.split('/').pop() || '').split('?')[0];
    if (!name) return null;
    let all = [];
    try {
      all = this.app.vault.getFiles() || [];
    } catch (e) {
      all = [];
    }
    const files = all.filter((f) => f.name === name);
    if (!files.length) return null;
    if (files.length === 1) return files[0];

    if (active && active.parent) {
      const sameDir = files.find((f) => f.parent && f.parent.path === active.parent.path);
      if (sameDir) return sameDir;
    }
    console.warn(
      '[' + PLUGIN_ID + '] 存在 ' + files.length + ' 个同名文件，已任选一个：' + name
    );
    return files[0];
  }

  attachGif(img) {
    img.classList.add('mfc-gif-source');
    img.title = '点击逐帧查看并选中，选中后可按 Delete 移除';
    // img 默认不可聚焦，不设置 tabindex 收不到键盘事件
    if (!img.hasAttribute('tabindex')) img.setAttribute('tabindex', '0');

    // GIF 的 Delete 走统一入口（未进入逐帧时 img 还在，直接用它）
    img.addEventListener('keydown', (e) => {
      this.handleDeleteKey(e, img);
    });

    // 一次点击同时完成两件事：选中 + 进入逐帧。
    // 选中标记随后会转移到可见的画布容器上（原 img 会被隐藏，描边看不见）。
    img.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      this.selectMedia(img);
      if (!this.settings.gifEnabled) return;
      if (this.players.get(img)) return;

      // 先同步作废上一个（包括还在挂载中的），避免异步竞态漏清理
      const previous = this.pendingPlayer || this.activePlayer;
      this.pendingPlayer = null;
      this.activePlayer = null;
      if (previous) previous.destroy();

      // 用一个立刻可见的占位，让后续点击能正确作废这次挂载
      const player = new GifPlayer(this, img, null, this.hintForElement(img));
      this.pendingPlayer = player;
      player.onDestroy = () => {
        this.players.delete(img);
        if (this.activePlayer === player) this.activePlayer = null;
        if (this.pendingPlayer === player) this.pendingPlayer = null;
      };

      let file = null;
      try {
        file = this.resolveFile(img);
      } catch (err) {
        file = null;
      }
      player.file = file;
      if (!file) {
        this.pendingPlayer = null;
        new Notice('找不到 GIF 源文件');
        return;
      }

      const ok = await player.mount();
      if (this.pendingPlayer !== player) {
        // 挂载期间你又点了别的，这个直接丢掉
        player.destroy();
        return;
      }
      this.pendingPlayer = null;
      if (ok) {
        this.players.set(img, player);
        this.activePlayer = player;
        // 选中标记搬到画布容器上，一次点击就能看到描边并直接按 Delete
        if (player.wrap) this.selectMedia(player.wrap);
      }
    });
  }

  attachVideo(video) {
    video.classList.add('mfc-video');
    video.tabIndex = 0;

    const parent = video.parentElement;
    if (!parent) return;

    let holder = parent;
    if (!parent.classList.contains('mfc-video-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'mfc-video-wrap';
      parent.insertBefore(wrap, video);
      wrap.appendChild(video);
      holder = wrap;
    }

    // 已经加过浮层就不重复加
    if (holder.querySelector(':scope > .mfc-video-bar')) {
      video.addEventListener('keydown', (e) => this.handleDeleteKey(e, video));
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'mfc-video-bar';

    const label = document.createElement('span');
    label.className = 'mfc-video-tag';
    label.textContent = '倍速';

    const select = document.createElement('select');
    select.className = 'mfc-speed';

    const speeds = String(this.settings.speeds || '')
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0.1 && n <= 3);

    const list = speeds.length ? speeds : [1];
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = s + 'x';
      select.appendChild(opt);
    }

    const clamp = (v) => Math.max(0.1, Math.min(3, v));
    const initial = clamp(Number(this.settings.defaultSpeed) || 1);
    select.value = String(list.includes(initial) ? initial : list[0]);
    video.playbackRate = parseFloat(select.value);

    select.addEventListener('change', () => {
      const rate = clamp(parseFloat(select.value) || 1);
      video.playbackRate = rate;
    });
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('mousedown', (e) => e.stopPropagation());

    // 源切换（同一 video 元素被复用播放另一个文件）时保持倍速不被重置
    video.addEventListener('loadedmetadata', () => {
      const want = parseFloat(select.value) || 1;
      if (Math.abs(video.playbackRate - want) > 0.001) {
        try {
          video.playbackRate = want;
        } catch (e) {
          /* ignore */
        }
      }
    });

    bar.appendChild(label);
    bar.appendChild(select);

    // 循环开关：默认按设置开启，每个视频各自可切换
    const loopBtn = document.createElement('button');
    loopBtn.type = 'button';
    loopBtn.className = 'mfc-loop';
    loopBtn.title = '循环播放';
    loopBtn.appendChild(makeIcon('loop'));

    const applyLoop = (on) => {
      video.loop = !!on;
      video.__mfcLoopOff = !on;
      if (on) loopBtn.classList.add('is-on');
      else loopBtn.classList.remove('is-on');
      loopBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    applyLoop(this.settings.loopVideo !== false);

    loopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      applyLoop(!video.loop);
    });
    loopBtn.addEventListener('mousedown', (e) => e.stopPropagation());

    bar.appendChild(loopBtn);

    // 浮层放进素材内部，不额外占一行
    holder.appendChild(bar);

    // 源被复用切换时补回循环设置
    video.addEventListener('loadedmetadata', () => {
      if (this.settings.loopVideo !== false && !video.__mfcLoopOff) video.loop = true;
    });

    video.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectMedia(video);
    });

    video.addEventListener('keydown', (e) => {
      this.handleDeleteKey(e, video);
    });
  }

  // 统一的删除按键处理；file 可以由调用方直接给（逐帧模式下的画布）
  handleDeleteKey(e, el, file) {
    if (e.key === 'Escape') {
      this.clearSelection();
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!this.settings.deleteOnKey) return;

    const target = file || this.resolveElementFile(el);
    if (!target) {
      new Notice('无法确定这条嵌入的链接');
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Delete 顺手删整行，Backspace 只删嵌入本身
    const ok = this.deleteEmbedFor(target, { removeLine: e.key === 'Delete' }, this.hintForElement(el));
    if (ok) {
      this.clearSelection();
      // 正在逐帧的话一并关掉
      const p = this.players.get(el);
      if (p) {
        p.destroy();
        this.players.delete(el);
      } else if (this.activePlayer) {
        this.activePlayer.destroy();
        this.activePlayer = null;
      }
    }
  }

  // 元素对应的库内文件
  resolveElementFile(el) {
    if (!el) return null;
    if (el.__mfcFile instanceof TFile) return el.__mfcFile;
    try {
      return this.resolveFile(el);
    } catch (e) {
      return null;
    }
  }

  // 元素自身能给出的链接写法（alt / src 尾段），用来和正文里的链接文本对照
  hintForElement(el) {
    if (!el) return '';
    if (el.__mfcHint) return el.__mfcHint;
    const alt = (el.getAttribute && el.getAttribute('alt')) || '';
    if (alt) return String(alt).trim();
    const src = (el.getAttribute && el.getAttribute('src')) || '';
    if (!src) return '';
    try {
      const u = new URL(src);
      return decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch (e) {
      return String(src).split('?')[0];
    }
  }

  selectMedia(el) {
    document.querySelectorAll('.mfc-selected').forEach((n) => {
      if (n !== el) n.classList.remove('mfc-selected');
    });
    el.classList.add('mfc-selected');
    this.selectedEl = el;
    this.bindSelectionDismiss();
    try {
      el.focus();
    } catch (e) {
      /* ignore */
    }
  }

  // 点空白处/focus 跑到别处时取消选中。
  // 用 document 上的捕获阶段监听：媒体自身的点击都会 stopPropagation，
  // 所以这里收到的事件一定是“点在了别处”。
  bindSelectionDismiss() {
    if (this.dismissBound) return;
    this.dismissBound = true;

    this.onDocPointerDown = (e) => {
      if (!this.selectedEl) return;
      const t = e.target;
      // 点在选中的元素内部（含逐帧控制条）不算取消
      if (t && this.selectedEl.contains && this.selectedEl.contains(t)) return;
      this.clearSelection();
    };

    this.onDocKeyDown = (e) => {
      if (e.key === 'Escape') this.clearSelection();
    };

    this.onDocFocusIn = (e) => {
      if (!this.selectedEl) return;
      const t = e.target;
      if (t && this.selectedEl.contains && this.selectedEl.contains(t)) return;
      // 焦点跑到别的媒体上时由那边自己接手，这里只处理跑出媒体的情况
      if (t && t.classList && (t.classList.contains('mfc-video') || t.classList.contains('mfc-gif-source') || t.classList.contains('mfc-gif-wrap'))) return;
      this.clearSelection();
    };

    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    document.addEventListener('mousedown', this.onDocPointerDown, true);
    document.addEventListener('keydown', this.onDocKeyDown, true);
    document.addEventListener('focusin', this.onDocFocusIn, true);
  }

  unbindSelectionDismiss() {
    if (!this.dismissBound) return;
    this.dismissBound = false;
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    document.removeEventListener('mousedown', this.onDocPointerDown, true);
    document.removeEventListener('keydown', this.onDocKeyDown, true);
    document.removeEventListener('focusin', this.onDocFocusIn, true);
    this.onDocPointerDown = null;
    this.onDocKeyDown = null;
    this.onDocFocusIn = null;
  }

  clearSelection() {
    if (this.selectedEl) this.selectedEl.classList.remove('mfc-selected');
    this.selectedEl = null;
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---------- 选中与删除 ----------

  getActiveEditorView() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.editor) return view;
    return null;
  }

  offsetOfPos(text, pos) {
    const lines = text.split('\n');
    let off = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) off += lines[i].length + 1;
    return off + pos.ch;
  }

  // 删掉这条嵌入。三层匹配，逐层放宽：
  //   1) 正文里的链接按「最短路径规则」能解析到同一个文件
  //   2) 链接文本与元素的 alt/src 原样相等（最贴近用户在正文里实际写的内容）
  //   3) 文件名在正文里唯一
  // 只靠第 1 层时，同名文件、被改名过的文件、路径写法差异都会误报“没找到”。
  deleteEmbedFor(file, opts, hint) {
    const view = this.getActiveEditorView();
    if (!view) {
      new Notice('请先切换到编辑模式的笔记');
      return false;
    }
    const editor = view.editor;
    const text = editor.getValue();
    const sourcePath = view.file && view.file.path ? view.file.path : '';
    const targetPath = file && file.path ? file.path : '';
    const targetName = (file && file.name) || '';
    const embeds = collectEmbeds(text);

    const norm = (s) => String(s || '').replace(/^\.\//, '').replace(/\\/g, '/').trim();

    let matches = [];

    // 1) 解析到同一个文件
    for (const emb of embeds) {
      const resolved = resolveLinkToFile(this.app, emb.link, sourcePath);
      if (resolved && resolved.path === targetPath) matches.push(emb);
    }

    // 2) 链接文本与元素给出的写法原样一致
    if (!matches.length && hint) {
      const wanted = new Set([norm(hint), norm(decodeURISafe(hint))].filter(Boolean));
      if (targetPath) wanted.add(norm(targetPath));
      if (targetName) wanted.add(norm(targetName));
      for (const emb of embeds) {
        const link = norm(emb.link);
        if (wanted.has(link)) matches.push(emb);
      }
    }

    // 3) 文件名在正文里唯一
    if (!matches.length && targetName) {
      const sameName = embeds.filter((emb) => norm(emb.link).split('/').pop() === targetName);
      if (sameName.length === 1) matches = sameName;
    }

    if (!matches.length) {
      new Notice('正文里没找到这条嵌入（可能已被改动）');
      return false;
    }

    let target = matches[0];
    if (matches.length > 1) {
      const cursor = editor.getCursor();
      const cursorOffset = editor.posToOffset
        ? editor.posToOffset(cursor)
        : this.offsetOfPos(text, cursor);
      let best = Infinity;
      for (const mm of matches) {
        const d = Math.abs(mm.from - cursorOffset);
        if (d < best) {
          best = d;
          target = mm;
        }
      }
    }

    let from = target.from;
    let to = target.to;

    if (opts && opts.removeLine) {
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      let lineEnd = text.indexOf('\n', to);
      if (lineEnd === -1) lineEnd = text.length;
      const before = text.slice(lineStart, from);
      const after = text.slice(to, lineEnd);
      if (!before.trim() && !after.trim()) {
        from = lineStart;
        to = Math.min(text.length, lineEnd + 1);
      }
    }

    editor.replaceRange('', editor.offsetToPos(from), editor.offsetToPos(to));
    return true;
  }
}

class MfcSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName('启用插件')
      .addToggle((t) =>
        t.setValue(s.enabled).onChange(async (v) => {
          s.enabled = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.scheduleScan();
        })
      );

    new Setting(containerEl)
      .setName('GIF 逐帧')
      .setDesc('点击 GIF 后，控制条浮在画面顶部（上一帧 / 播放暂停 / 下一帧）')
      .addToggle((t) =>
        t.setValue(s.gifEnabled).onChange(async (v) => {
          s.gifEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('视频倍速')
      .setDesc('倍速选择器浮在视频右上角，点击视频可选中')
      .addToggle((t) =>
        t.setValue(s.videoEnabled).onChange(async (v) => {
          s.videoEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('倍速选项')
      .setDesc('英文逗号分隔，范围 0.1 到 3')
      .addText((t) =>
        t.setValue(s.speeds).onChange(async (v) => {
          s.speeds = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('默认倍速')
      .addText((t) =>
        t.setValue(String(s.defaultSpeed)).onChange(async (v) => {
          const n = parseFloat(v);
          s.defaultSpeed = Number.isFinite(n) ? Math.max(0.1, Math.min(3, n)) : 1;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('默认循环播放')
      .setDesc('视频默认循环；每个视频右上角也能单独切换')
      .addToggle((t) =>
        t.setValue(s.loopVideo !== false).onChange(async (v) => {
          s.loopVideo = v;
          await this.plugin.saveSettings();
          // 立刻应用到已存在的视频上
          document.querySelectorAll('.mfc-video').forEach((video) => {
            video.loop = v;
            const bar = video.parentElement && video.parentElement.querySelector('.mfc-video-bar');
            const btn = bar && bar.querySelector('.mfc-loop');
            if (btn) {
              if (v) btn.classList.add('is-on');
              else btn.classList.remove('is-on');
            }
          });
        })
      );

    new Setting(containerEl)
      .setName('GIF 最大帧数')
      .setDesc('超过则不做逐帧解析')
      .addText((t) =>
        t.setValue(String(s.maxFrames)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.maxFrames = Number.isFinite(n) && n > 0 ? n : 400;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('GIF 最大体积（MB）')
      .setDesc('超过则不做逐帧解析')
      .addText((t) =>
        t.setValue(String(s.maxFileMB)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.maxFileMB = Number.isFinite(n) && n > 0 ? n : 80;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('方向键与 Delete 删除')
      .setDesc('点选图片/视频后按 Delete 移除这条嵌入（只改正文，不动文件，也不进回收站）')
      .addToggle((t) =>
        t.setValue(s.deleteOnKey).onChange(async (v) => {
          s.deleteOnKey = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = MediaFrameControl;
