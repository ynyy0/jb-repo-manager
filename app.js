(function () {
  'use strict';

  var API = 'https://api.github.com';
  var OWNER = 'ynyy0';
  var REPO = 'ynyy0.github.io';
  var BRANCH = 'main';
  var MAX_BYTES = 50 * 1024 * 1024;

  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  var toastTimer = null;
  var seq = 0;

  var state = {
    files: [],           // {path, sha, size}
    iconIndex: {},       // lowercase path -> real path
    iconSha: {},         // lowercase path -> blob sha（用于破图标缓存）
    iconPreviews: {},    // lowercase path -> 本地预览 blob URL（未提交）
    index: { byFilename: {}, byPackage: {} },
    meta: { plugins: {} },                       // 仓库基线（loadAll 总是刷新）
    edits: { plugins: {}, categories: null },    // 本地未提交的改动
    _eff: null,                                  // 合并后的视图缓存
    plugins: [],
    pending: [],
    commitError: '',
    view: 'dirs',
    navDir: '',
    catFilter: null
  };

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
  function dirname(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function cleanDir(s) { return String(s || '').trim().replace(/^\/+|\/+$/g, ''); }
  function validDir(s) { return !!s && !/[\\]/.test(s) && s.indexOf('..') < 0; }
  function guessPackage(fn) {
    var s = fn.replace(/\.deb$/i, '').replace(/_iphoneos-arm64e?$/i, '');
    var i = s.lastIndexOf('_');
    return i > 0 ? s.slice(0, i) : s;
  }
  function rawUrl(p) {
    return 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + BRANCH + '/' +
      p.split('/').map(encodeURIComponent).join('/');
  }
  function toast(text, isErr) {
    var el = $('toast');
    el.textContent = text;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3200);
  }
  function setMsg(id, text, isErr) {
    var el = $(id);
    el.className = 'msg' + (isErr ? ' err' : (text ? ' ok' : ''));
    el.textContent = text;
  }
  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function textToBase64(s) {
    var bytes = new TextEncoder().encode(s);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  // ---------- GitHub API ----------
  function repoPath(suffix) { return '/repos/' + OWNER + '/' + REPO + suffix; }
  async function gh(path, opts) {
    opts = opts || {};
    var headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    var r = await fetch(API + path, {
      method: opts.method || 'GET', headers: headers, body: opts.body || undefined
    });
    if (!r.ok) {
      var detail = '';
      try { var j = await r.json(); detail = j.message || ''; } catch (e) { /* ignore */ }
      if (r.status === 403 && /Resource not accessible by personal access token/i.test(detail)) {
        throw new Error('PAT 权限不足：需要对 ynyy0.github.io 的 Contents: Read and Write（写权限）。' +
          '请重新生成 Token，然后在本页「连接」里断开并重新粘贴。');
      }
      if (r.status === 401) throw new Error('Token 无效或已过期，请重新生成并重新连接。');
      if (r.status === 409) throw new Error('提交冲突：期间仓库有新提交。请点「刷新仓库」后重试。');
      throw new Error(r.status + ' ' + r.statusText + (detail ? ' — ' + detail : ''));
    }
    return r.status === 204 ? null : r.json();
  }
  async function makeBlobFromBase64(b64) {
    var r = await gh(repoPath('/git/blobs'), {
      method: 'POST', body: JSON.stringify({ content: b64, encoding: 'base64' })
    });
    return r.sha;
  }
  async function blobFromText(s) { return makeBlobFromBase64(textToBase64(s)); }

  function parseIndex(text) {
    var byFilename = {}, byPackage = {};
    String(text).trim().split(/\n\s*\n/).forEach(function (block) {
      var d = {};
      block.split('\n').forEach(function (line) {
        var i = line.indexOf(': ');
        if (i > 0) d[line.slice(0, i)] = line.slice(i + 2);
      });
      if (d.Package) {
        byPackage[d.Package] = d;
        if (d.Filename) {
          var fn = String(d.Filename).replace(/^\.\//, '').replace(/^\//, '');
          byFilename[fn] = d;
        }
      }
    });
    return { byFilename: byFilename, byPackage: byPackage };
  }

  // ---------- 元数据：基线 + 本地改动 ----------
  function mergeMeta(base, edits) {
    var out = { plugins: {} };
    var bp = (base && base.plugins) || {};
    Object.keys(bp).forEach(function (k) { out.plugins[k] = Object.assign({}, bp[k]); });
    var ep = (edits && edits.plugins) || {};
    Object.keys(ep).forEach(function (k) {
      out.plugins[k] = Object.assign(out.plugins[k] || {}, ep[k]);
    });
    if (edits && edits.categories != null) out.categories = edits.categories.slice();
    else if (base && base.categories) out.categories = base.categories.slice();
    return out;
  }
  function effMeta() { return state._eff || mergeMeta(state.meta, state.edits); }
  function hasEdits() {
    return Object.keys(state.edits.plugins || {}).length > 0 || state.edits.categories !== null;
  }
  function emptyEdits() { return { plugins: {}, categories: null }; }

  async function loadRepoMeta() {
    var metaFile = state.files.find(function (f) { return f.path === 'repo-meta.json'; });
    if (!metaFile) return { plugins: {} };
    try {
      var blob = await gh(repoPath('/git/blobs/' + metaFile.sha));
      var parsed = JSON.parse(b64ToUtf8(blob.content));
      return parsed && parsed.plugins ? parsed : { plugins: {} };
    } catch (e) { return { plugins: {} }; }
  }

  // ---------- data ----------
  async function loadAll() {
    toast('读取仓库…');
    var ref = await gh(repoPath('/git/ref/heads/' + BRANCH));
    var tree = await gh(repoPath('/git/trees/' + ref.object.sha + '?recursive=1'));
    if (tree.truncated) toast('GitHub 文件树被截断，部分内容可能缺失', true);
    state.files = tree.tree.filter(function (x) { return x.type === 'blob'; }).map(function (x) {
      return { path: x.path, sha: x.sha, size: x.size || 0 };
    });

    state.iconIndex = {};
    state.iconSha = {};
    state.files.forEach(function (f) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(f.path)) {
        state.iconIndex[f.path.toLowerCase()] = f.path;
        state.iconSha[f.path.toLowerCase()] = f.sha || '';
      }
    });

    try {
      var r = await fetch(rawUrl('Packages') + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) state.index = parseIndex(await r.text());
    } catch (e) { /* 索引不可用时退化为文件名显示 */ }

    // 基线总是取仓库最新值，绝不用浏览器里的旧快照覆盖
    state.meta = await loadRepoMeta();
    rebuild();

    // 兼容历史遗留：把用「文件名猜的包名」当 key 的覆盖迁移到真实包标识符
    var migrated = 0;
    state.plugins.forEach(function (p) {
      if (p.pkg === p.realPkg) return;
      var old = (state.meta.plugins || {})[p.pkg];
      if (!old) return;
      var e = state.edits.plugins[p.realPkg] = state.edits.plugins[p.realPkg] || {};
      Object.keys(old).forEach(function (k) { if (!(k in e)) e[k] = old[k]; });
      migrated++;
    });
    if (migrated) noteMetaOnly('规范化元数据键（' + migrated + ' 个）');
    render();
    toast('已加载 ' + state.plugins.length + ' 个插件' + (hasEdits() ? '（有未提交改动）' : ''));
  }

  function rebuild() {
    state._eff = mergeMeta(state.meta, state.edits);
    var meta = state._eff.plugins || {};
    var iconIndex = state.iconIndex;
    var previews = state.iconPreviews;
    state.plugins = state.files.filter(function (f) {
      return /\.deb$/i.test(f.path);
    }).map(function (f) {
      var pkg = guessPackage(basename(f.path));
      var info = state.index.byFilename[f.path] || state.index.byPackage[pkg] || {};
      var realPkg = info.Package || pkg;
      var ov = meta[realPkg] || meta[pkg] || {};
      var edited = !!(state.edits.plugins[realPkg] || state.edits.plugins[pkg]);
      var wantIcon = 'icons/' + realPkg + '.png';
      var localIcon = iconIndex[wantIcon.toLowerCase()] || null;
      var icon = ov.icon || (localIcon ? localIcon :
        (info.Icon && /^https?:/.test(info.Icon) ? info.Icon : 'CydiaIcon.png'));
      var fallbackIcon = info.Icon && /^https?:/.test(info.Icon) ? info.Icon : 'CydiaIcon.png';
      var url;
      if (localIcon && previews[localIcon.toLowerCase()]) {
        url = previews[localIcon.toLowerCase()];
      } else if (/^https?:/.test(icon)) {
        url = icon;
      } else {
        // 用文件 sha 作版本号：图标内容变了 URL 就变，客户端缓存自动失效
        var v = (state.iconSha[icon.toLowerCase()] || '').slice(0, 8) || '0';
        url = rawUrl(icon) + '?v=' + v;
      }
      return {
        path: f.path, dir: dirname(f.path), sha: f.sha, size: f.size, pkg: pkg,
        realPkg: realPkg, edited: edited,
        pendingIcon: !!(localIcon && previews[localIcon.toLowerCase()]),
        name: ov.name || info.Name || pkg,
        version: info.Version || '',
        desc: ov.description || info.Description || '',
        section: info.Section || '',
        icon: icon, iconUrl: url, iconFallback: /^https?:/.test(fallbackIcon)
          ? fallbackIcon : rawUrl(fallbackIcon),
        iconPath: localIcon
      };
    });
  }

  function findPlugin(path) {
    return state.plugins.find(function (p) { return p.path === path; });
  }

  // ---------- 分类（分组） ----------
  function pluginCats(p) {
    var m = effMeta().plugins || {};
    var ov = m[p.realPkg] || m[p.pkg] || {};
    if (ov.cats && ov.cats.length) return ov.cats.slice();
    return [ov.section || p.section || '未分类'];
  }
  function pluginsInCat(cat) {
    return state.plugins.filter(function (p) { return pluginCats(p).indexOf(cat) >= 0; });
  }
  function categories() {
    var em = effMeta();
    if (em.categories) return em.categories.slice();
    var map = {};
    state.plugins.forEach(function (p) {
      pluginCats(p).forEach(function (c) { map[c] = 1; });
    });
    var names = Object.keys(map);
    if (!names.length) names = ['未分类'];
    names.sort(function (a, b) { return pluginsInCat(b).length - pluginsInCat(a).length; });
    return names;
  }
  function setCategories(list) {
    state.edits.categories = list.slice();
    noteMetaOnly('更新分类目录');
  }

  // ---------- 物理目录树 ----------
  function allDirs() {
    var set = {};
    function add(fp) {
      var parts = String(fp).split('/');
      parts.pop();
      var cur = '';
      parts.forEach(function (seg) {
        cur = cur ? cur + '/' + seg : seg;
        if (cur) set[cur] = 1;
      });
    }
    state.files.forEach(function (f) { add(f.path); });
    state.pending.forEach(function (p) {
      if (p.op === 'add') add(p.path);
      if (p.op === 'move') add(p.newPath);
    });
    return Object.keys(set).sort();
  }
  function childDirs(parent) {
    var pref = parent ? parent + '/' : '';
    var set = {};
    allDirs().forEach(function (d) {
      if (parent && d.indexOf(pref) !== 0) return;
      var rest = parent ? d.slice(pref.length) : d;
      if (!rest) return;
      var seg = rest.split('/')[0];
      if (seg) set[pref + seg] = 1;
    });
    return Object.keys(set).sort();
  }
  function filesInDir(dir) {
    return state.files.filter(function (f) { return dirname(f.path) === dir; });
  }
  function debCountInTree(dir) {
    var pref = dir ? dir + '/' : '';
    return state.plugins.filter(function (p) {
      return !dir || p.path.indexOf(pref) === 0;
    }).length;
  }

  // ---------- pending ----------
  function addPending(p) {
    if (p.op === 'add') {
      state.pending = state.pending.filter(function (x) {
        return !(x.op === 'add' && x.path === p.path);
      });
    }
    p.id = ++seq;
    state.pending.push(p);
    rebuild(); render();
  }
  function removePending(id) {
    state.pending = state.pending.filter(function (p) { return String(p.id) !== id; });
    rebuild(); render();
  }
  function noteMetaOnly(text) {
    var exist = state.pending.find(function (p) { return p.op === 'meta'; });
    if (exist) { exist.text = text; rebuild(); render(); }
    else addPending({ op: 'meta', text: text });
  }
  function setMetaFor(pkg, cats, section) {
    var e = state.edits.plugins[pkg] = state.edits.plugins[pkg] || {};
    e.cats = cats.slice();
    if (section) e.section = section;
    noteMetaOnly('元数据：' + pkg + ' → ' + cats.join(' / '));
  }

  // ---------- 会话持久化：只存「改动」，不存仓库快照 ----------
  function saveState() {
    try {
      var keep = state.pending.filter(function (p) { return !p.file; }).map(function (p) {
        return {
          id: p.id, op: p.op, path: p.path, newPath: p.newPath, sha: p.sha,
          text: p.text, size: p.size, note: p.note
        };
      });
      sessionStorage.setItem('jbrm_state', JSON.stringify({
        v: 2, pending: keep, edits: state.edits, commitError: state.commitError
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function restoreState() {
    try {
      var raw = sessionStorage.getItem('jbrm_state');
      if (!raw) return;
      var s = JSON.parse(raw);
      // v1 是整份 meta 快照，会覆盖仓库数据 —— 直接丢弃
      if (s.v !== 2) { sessionStorage.removeItem('jbrm_state'); return; }
      if (s.pending && s.pending.length) state.pending = s.pending;
      if (s.edits) {
        state.edits = {
          plugins: s.edits.plugins || {},
          categories: s.edits.categories != null ? s.edits.categories : null
        };
      }
      state.commitError = s.commitError || '';
      seq = state.pending.reduce(function (m, p) {
        return Math.max(m, Number(p.id) || 0);
      }, 0);
    } catch (e) { /* ignore */ }
  }
  async function clearLocalCache(silent) {
    try {
      Object.keys(state.iconPreviews).forEach(function (k) {
        URL.revokeObjectURL(state.iconPreviews[k]);
      });
      state.iconPreviews = {};
      state.pending = [];
      state.edits = emptyEdits();
      state.commitError = '';
      sessionStorage.removeItem('jbrm_state');
      localStorage.removeItem('jbrm_cache_notice');
      await loadAll();
      if (!silent) toast('本地缓存已清除，已重新读取仓库最新状态');
    } catch (e) {
      if (!silent) toast('清除失败：' + e.message, true);
    }
  }

  // ---------- rendering ----------
  function render() {
    saveState();
    var v = state.view;
    $('view-dirs').hidden = v !== 'dirs';
    $('view-plugins').hidden = v !== 'plugins';
    $('view-pending').hidden = v !== 'pending';
    $('view-me').hidden = v !== 'me';

    var canBack = (v === 'dirs' && !!state.navDir) || (v === 'plugins' && !!state.catFilter);
    $('nav-back').hidden = !canBack;
    $('nav-add').hidden = (v === 'me' || v === 'pending');

    var titles = { dirs: state.navDir || '目录', pending: '待提交', me: '连接' };
    $('nav-title').textContent = v === 'plugins'
      ? (!state.catFilter ? '分类' : (state.catFilter === '__all__' ? '全部插件' : state.catFilter))
      : titles[v];
    $('nav-add').textContent = '+';

    var searchable = (v === 'dirs' || v === 'plugins');
    $('search').parentNode.hidden = !searchable;
    $('search').placeholder = v === 'dirs' ? '搜索目录 / 插件'
      : (state.catFilter ? '搜索插件' : '搜索分类');

    var dirty = state.pending.length || (hasEdits() ? 1 : 0) ||
      Object.keys(state.iconPreviews).length;
    var bar = $('dirty-bar');
    bar.hidden = dirty === 0;
    if (dirty) {
      $('dirty-text').textContent = '⚠ ' + (state.pending.length || '若干') +
        ' 项改动仅在本地预览，提交后才会生效';
    }

    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === v);
    });
    var badge = $('tab-badge');
    badge.hidden = state.pending.length === 0;
    badge.textContent = state.pending.length;

    if (v === 'dirs') renderDirs();
    if (v === 'plugins') renderPlugins();
    if (v === 'pending') renderPending();
    if (v === 'me') renderMe();
  }

  function pluginCards(list) {
    if (!list.length) return '';
    var html = '<div class="list-card">';
    list.forEach(function (p) {
      html += '<div class="plugin">' +
        '<img class="picon" src="' + esc(p.iconUrl) + '" alt="" loading="lazy" ' +
        'onerror="this.onerror=null;this.src=\'' + esc(p.iconFallback) + '\'">' +
        '<div class="pinfo"><div class="pname">' + esc(p.name) +
        (p.edited || p.pendingIcon ? '<span class="tag-pending">待提交</span>' : '') + '</div>' +
        '<div class="pmeta">' + esc(p.version || p.pkg) +
        (p.section ? ' · ' + esc(p.section) : '') + ' · ' + fmtSize(p.size) + '</div>' +
        (p.desc ? '<div class="pdesc">' + esc(p.desc) + '</div>' : '') + '</div>' +
        '<button class="pmore" data-plugin="' + esc(p.path) + '" aria-label="插件选项">⋯</button></div>';
    });
    return html + '</div>';
  }

  function renderDirs() {
    var q = $('search').value.trim().toLowerCase();
    var cur = state.navDir;
    var subs = childDirs(cur).filter(function (d) {
      return !q || basename(d).toLowerCase().indexOf(q) >= 0;
    });
    var directDebs = state.plugins.filter(function (p) {
      if (p.dir !== cur) return false;
      return !q || (p.name + ' ' + p.pkg + ' ' + p.desc).toLowerCase().indexOf(q) >= 0;
    });
    var otherFiles = filesInDir(cur).filter(function (f) { return !/\.deb$/i.test(f.path); });
    var images = otherFiles.filter(function (f) { return /\.(png|jpe?g|webp|gif)$/i.test(f.path); });

    var html = '<div class="section-title">' + (cur || '仓库根目录') + ' · ' +
      subs.length + ' 个目录</div>';
    html += '<div class="list-card">';
    subs.forEach(function (d) {
      var childSubs = childDirs(d).length;
      html += '<div class="cell" data-open="' + esc(d) + '">' +
        '<div class="cell-main"><div class="cell-name">' + esc(basename(d)) + '</div>' +
        '<div class="cell-sub">' + debCountInTree(d) + ' 个插件 · ' +
        filesInDir(d).length + ' 个文件' + (childSubs ? ' · ' + childSubs + ' 个子目录' : '') + '</div></div>' +
        '<span class="cell-count">' + debCountInTree(d) + '</span>' +
        '<button class="cell-btn" data-dirmenu="' + esc(d) + '" aria-label="目录选项">⋯</button>' +
        '<span class="chev">›</span></div>';
    });
    if (!subs.length) html += '<div class="empty">' + (q ? '没有匹配的目录' : '没有子目录') + '</div>';
    html += '</div>';

    if (images.length) {
      html += '<div class="section-title">图标库 · ' + images.length + ' 张（点图看大图）</div><div class="icon-grid">';
      images.forEach(function (f) {
        var v = (f.sha || '').slice(0, 8) || '0';
        var u = rawUrl(f.path) + '?v=' + v;
        html += '<div class="icon-item" data-icon="' + esc(u) + '" data-iconname="' +
          esc(basename(f.path)) + '"><img src="' + esc(u) + '" alt="" loading="lazy" ' +
          'onerror="this.style.opacity=.25"><span>' + esc(basename(f.path)) + '</span></div>';
      });
      html += '</div>';
    }
    if (directDebs.length) {
      html += '<div class="section-title">本目录插件 · ' + directDebs.length + ' 个</div>';
      html += pluginCards(directDebs);
    }
    var rest = otherFiles.length - images.length;
    if (rest > 0) {
      html += '<div class="card"><b>其它文件</b><p class="hint">' + rest + ' 个（索引、页面等）</p></div>';
    }
    if (!q && !cur) {
      html += '<div class="card"><b>提示</b><p class="hint">点目录行进入子目录；' +
        '点 ⋯ 可重命名 / 删除目录、在此上传插件。进入 icons/ 可查看全部图标。</p></div>';
    }
    $('view-dirs').innerHTML = html;
  }

  function renderCats(q) {
    var names = categories().filter(function (c) {
      return !q || c.toLowerCase().indexOf(q) >= 0;
    });
    var custom = state.edits.categories !== null || effMeta().categories;
    var html = '<div class="section-title">分类目录 · ' + names.length + ' 个' +
      (state.edits.categories !== null ? '<span class="tag-pending">待提交</span>' : '') + '</div>';
    html += '<div class="list-card">';
    html += '<div class="cell" data-cat="__all__"><div class="cell-main">' +
      '<div class="cell-name">全部插件</div>' +
      '<div class="cell-sub">所有分类 · 共 ' + state.plugins.length + ' 个</div></div>' +
      '<span class="cell-count">' + state.plugins.length + '</span><span class="chev">›</span></div>';
    names.forEach(function (c) {
      var n = pluginsInCat(c).length;
      html += '<div class="cell" data-cat="' + esc(c) + '">' +
        '<div class="cell-main"><div class="cell-name">' + esc(c) + '</div>' +
        '<div class="cell-sub">' + n + ' 个插件</div></div>' +
        '<span class="cell-count">' + n + '</span>' +
        '<button class="cell-btn" data-catmenu="' + esc(c) + '" aria-label="分类目录选项">⋯</button>' +
        '<span class="chev">›</span></div>';
    });
    html += '</div>';
    if (!names.length) html += '<div class="empty">' + (q ? '没有匹配的分类' : '还没有分类') + '</div>';
    html += '<div class="card"><b>提示</b><p class="hint">右上角 + 添加目录；分类 ⋯ 可重命名 / 删除目录。' +
      (custom ? '' : '当前分组按索引里的 Section 自动生成。') +
      '改动需提交后才写入仓库。</p></div>';
    $('view-plugins').innerHTML = html;
  }

  function renderPlugins() {
    var q = $('search').value.trim().toLowerCase();
    if (!state.catFilter) return renderCats(q);
    var list = (state.catFilter === '__all__' ? state.plugins : pluginsInCat(state.catFilter))
      .filter(function (p) {
        return !q || (p.name + ' ' + p.pkg + ' ' + p.desc).toLowerCase().indexOf(q) >= 0;
      });
    var title = state.catFilter === '__all__' ? '全部插件' : state.catFilter;
    var html = '<div class="section-title">' + esc(title) + ' · ' + list.length + ' 个插件</div>';
    if (!list.length) html += '<div class="empty">这里还没有插件</div>';
    else html += pluginCards(list);
    $('view-plugins').innerHTML = html;
  }

  function renderPending() {
    var label = { add: '新增', delete: '删除', move: '移动', meta: '元数据' };
    var cls = { add: 'add', delete: 'del', move: 'mov', meta: 'meta' };
    var html = '<div class="stat"><div><b>' + state.plugins.length + '</b><span>插件</span></div>' +
      '<div><b>' + categories().length + '</b><span>分类</span></div>' +
      '<div><b>' + state.pending.length + '</b><span>待提交</span></div></div>';
    html += '<div class="card"><b>⚠ 这些改动还没生效</b><p class="hint">' +
      '下面的改动只是本地预览，只有点「提交更改」写入仓库后才会真正生效、并触发源索引刷新。' +
      '提交失败时改动会保留，可重试；也可点「清除本地缓存」丢弃全部未提交改动。</p></div>';
    html += '<div class="section-title">待提交变更</div><div class="list-card">';
    if (!state.pending.length) {
      html += '<div class="empty">还没有改动</div>';
    } else {
      state.pending.forEach(function (p) {
        var text = p.op === 'move' ? p.path + ' → ' + p.newPath : (p.text || p.path);
        html += '<div class="change"><span class="tag ' + cls[p.op] + '">' + label[p.op] + '</span>' +
          '<span class="txt">' + esc(text) +
          (p.note ? '<small>' + esc(p.note) + '</small>' : '') + '</span>' +
          (p.op === 'meta' ? '' : '<button class="mini" data-undo="' + p.id + '">撤销</button>') + '</div>';
      });
    }
    html += '</div>';
    if (state.commitError) {
      html += '<div class="card err-card"><b>上次提交失败（改动未生效）</b>' +
        '<p class="hint err-text">' + esc(state.commitError) + '</p>' +
        '<p class="hint"><b>怎么修</b><br>' +
        '① 生成 PAT：<b>classic</b> 勾 <code>repo</code>；<b>fine-grained</b> 选 Resource owner <code>ynyy0</code>、仓库 <code>ynyy0.github.io</code>、权限 <b>Contents: Read and Write</b><br>' +
        '② 回「连接」页 → 断开 → 粘贴新 Token 重新连接<br>' +
        '③ 回来重新提交（改动不会丢）</p>' +
        '<div class="row" style="margin-top:12px">' +
        '<a class="btn grow linkbtn" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">生成新 PAT ↗</a>' +
        '<button id="btn-selftest2" class="btn grow">权限自检</button></div></div>';
    }
    html += '<div class="commit-bar"><button id="btn-commit" class="btn primary block"' +
      (state.pending.length ? '' : ' disabled') + '>提交更改（' + state.pending.length + '）</button>' +
      '<button id="btn-clear" class="btn block"' + (state.pending.length ? '' : ' disabled') +
      ' style="margin-top:9px">清空待提交</button>' +
      '<button id="btn-clearcache2" class="btn block" style="margin-top:9px">清除本地缓存</button>' +
      '<p class="hint">提交时会读取仓库最新元数据再合并，不会用旧缓存覆盖别人的改动。</p></div>';
    $('view-pending').innerHTML = html;
    $('btn-commit').onclick = commit;
    $('btn-clear').onclick = function () {
      confirmSheet('清空待提交', '将丢弃全部 ' + state.pending.length +
        ' 项未提交改动（改名、归类、上传等），此操作不可撤销。', '确认清空', function () {
        state.pending = [];
        state.edits = emptyEdits();
        Object.keys(state.iconPreviews).forEach(function (k) { URL.revokeObjectURL(state.iconPreviews[k]); });
        state.iconPreviews = {};
        rebuild(); render(); toast('已清空');
      });
    };
    $('btn-clearcache2').onclick = function () {
      confirmSheet('清除本地缓存', '将丢弃浏览器里保存的全部未提交改动，并从仓库重新读取最新数据。Token 不会被清除。', '确认清除', function () {
        clearLocalCache();
      });
    };
    if ($('btn-selftest2')) {
      $('btn-selftest2').onclick = function () {
        state.view = 'me'; render(); runSelfTest(); window.scrollTo(0, 0);
      };
    }
  }

  function renderMe() {
    $('view-me').innerHTML =
      '<div class="card"><b>当前连接</b><p class="hint">目标仓库：<code>' + OWNER + '/' + REPO +
      '</code><br>分支：<code>' + BRANCH + '</code><br>管理台仓库：<code>ynyy0/jb-repo-manager</code></p>' +
      '<div class="row" style="margin-top:14px"><button id="btn-refresh2" class="btn grow">刷新仓库</button>' +
      '<button id="btn-logout" class="btn danger grow">断开</button></div>' +
      '<button id="btn-selftest" class="btn block" style="margin-top:10px">权限自检（查为什么提交失败）</button>' +
      '<button id="btn-clearcache" class="btn block" style="margin-top:10px">清除本地缓存</button>' +
      '<div id="selftest-result"></div></div>' +
      '<div class="card"><b>使用说明</b><p class="hint">' +
      '① 目录页逐级进入子目录，进入 icons/ 可查看图标库；<br>' +
      '② 全部插件页是分类目录，+ 添加目录，分类 ⋯ 可重命名 / 删除；<br>' +
      '③ 插件 ⋯ 可改名、改图标、移动到… / 剪切到…（选分类或仓库目录）、删除；<br>' +
      '④ 所有改动先进入「待提交」，只有提交后才真正生效；<br>' +
      '⑤ 改图标存成 <code>icons/包标识符.png</code>，图标链接自带版本号，换图后客户端不会再用旧缓存。</p></div>' +
      '<div class="card"><b>关于 Token</b><p class="hint">只保存在本机浏览器，直发 api.github.com，' +
      '不写入仓库、不经过第三方。可随时「断开」清除。</p></div>';
    $('btn-refresh2').onclick = function () {
      loadAll().then(function () { toast('已重新读取仓库最新状态'); })
        .catch(function (e) { toast('刷新失败：' + e.message, true); });
    };
    $('btn-logout').onclick = logout;
    $('btn-selftest').onclick = runSelfTest;
    $('btn-clearcache').onclick = function () {
      confirmSheet('清除本地缓存', '将丢弃浏览器里保存的全部未提交改动，并从仓库重新读取最新数据。Token 不会被清除。', '确认清除', function () {
        clearLocalCache();
      });
    };
  }

  // ---------- sheets & dialogs ----------
  var sheetActions = [];
  function openSheet(title, actions, message) {
    sheetActions = actions;
    $('sheet-title').textContent = title;
    $('sheet-actions').innerHTML =
      (message ? '<p class="sheet-msg">' + esc(message) + '</p>' : '') +
      actions.map(function (a, i) {
        return '<button class="' + (a.danger ? 'danger' : '') + '" data-act="' + i + '">' +
          '<span class="si">' + (a.icon || '•') + '</span><span>' + esc(a.label) + '</span></button>';
      }).join('');
    $('sheet').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; }
  function confirmSheet(title, message, okLabel, onOk) {
    openSheet(title, [
      { label: '取消', icon: '×', fn: function () {} },
      { label: okLabel || '确认删除', icon: '✕', danger: true, fn: onOk }
    ], message);
  }

  var dialogCb = null;
  function openDialog(title, value, hint, cb) {
    dialogCb = cb;
    $('dialog-title').textContent = title;
    $('dialog-hint').textContent = hint || '';
    $('dialog-input').value = value || '';
    $('dialog').hidden = false;
    setTimeout(function () { $('dialog-input').focus(); }, 50);
  }
  function closeDialog() { $('dialog').hidden = true; dialogCb = null; }

  // 目标 = 分类目录（默认）＋ 真实仓库目录（可选，会真的移动 deb）
  function pickTarget(title, cb) {
    var actions = [];
    categories().forEach(function (c) {
      actions.push({ label: '分类 · ' + c, icon: '▣', fn: function () { cb({ type: 'cat', value: c }); } });
    });
    actions.push({
      label: '新建分类目录…', icon: '+', fn: function () {
        openDialog('新建分类目录', '', '输入目录名，然后直接归到它', function (v) {
          var name = String(v).trim();
          if (!name) return toast('目录名不能为空', true);
          var cs = categories();
          if (cs.indexOf(name) < 0) { cs.push(name); setCategories(cs); }
          cb({ type: 'cat', value: name });
        });
      }
    });
    allDirs().filter(function (d) {
      return d !== '.github' && d.indexOf('.github/') !== 0;
    }).forEach(function (d) {
      actions.push({ label: '仓库目录 · ' + d + '/', icon: '▸', fn: function () { cb({ type: 'dir', value: d }); } });
    });
    actions.push({
      label: '新建仓库目录…', icon: '+', fn: function () {
        openDialog('新建仓库目录', '', '输入目录名，deb 会真的移动过去', function (v) {
          var name = cleanDir(v);
          if (!validDir(name)) return toast('目录名不合法', true);
          var full = cleanDir(name);
          if (allDirs().indexOf(full) < 0) {
            addPending({ op: 'add', path: full + '/.gitkeep', text: '\n', note: '新建目录' });
          }
          cb({ type: 'dir', value: full });
        });
      }
    });
    openSheet(title, actions,
      '选「分类」只改归类、deb 文件不动；选「仓库目录」会真的移动 deb 文件。移出 debs/ 的插件不会出现在 APT 索引里。');
  }

  // ---------- 分类目录操作 ----------
  function addCategory() {
    openDialog('添加目录', '', '输入分类目录名（添加后需提交才生效）', function (v) {
      var name = String(v).trim();
      if (!name) return toast('目录名不能为空', true);
      var cs = categories();
      if (cs.indexOf(name) >= 0) return toast('目录已存在', true);
      cs.push(name);
      setCategories(cs);
      toast('已加入待提交：添加目录「' + name + '」，请点提交');
    });
  }

  function catMenu(cat) {
    var actions = [
      { label: '重命名目录', icon: '✎', fn: function () {
        openDialog('重命名目录', cat, '该分类下 ' + pluginsInCat(cat).length +
          ' 个插件会一起归到新名称（需提交才生效）', function (v) {
          var nw = String(v).trim();
          if (!nw || nw === cat) return toast('名称不合法或未变化', true);
          var cs = categories();
          if (cs.indexOf(nw) >= 0 && nw !== cat) return toast('目录已存在', true);
          state.edits.categories = cs.map(function (c) { return c === cat ? nw : c; });
          state.plugins.forEach(function (p) {
            var pc = pluginCats(p);
            if (pc.indexOf(cat) < 0) return;
            var nc = pc.map(function (c) { return c === cat ? nw : c; });
            var m = effMeta().plugins || {};
            var ov = m[p.realPkg] || {};
            setMetaFor(p.realPkg, nc, (ov.section || p.section) === cat ? nw : ov.section);
          });
          noteMetaOnly('重命名目录：' + cat + ' → ' + nw);
          if (state.catFilter === cat) state.catFilter = nw;
          toast('已加入待提交，请点提交');
        });
      } },
      { label: '删除目录', icon: '✕', danger: true, fn: function () {
        confirmSheet('删除分类目录',
          '将移除「' + cat + '」分组，组内 ' + pluginsInCat(cat).length +
          ' 个插件归入「未分类」。deb 文件不会被删除，但改动需提交后才生效。',
          '继续', function () {
            openDialog('删除目录', '', '输入目录名「' + cat + '」确认删除', function (v) {
              if (String(v).trim() !== cat) return toast('输入的目录名不一致，已取消', true);
              var cs = categories().filter(function (c) { return c !== cat; });
              if (cs.indexOf('未分类') < 0) cs.push('未分类');
              state.edits.categories = cs;
              state.plugins.forEach(function (p) {
                var pc = pluginCats(p);
                if (pc.indexOf(cat) < 0) return;
                var nc = pc.filter(function (c) { return c !== cat; });
                if (!nc.length) nc = ['未分类'];
                var m = effMeta().plugins || {};
                var ov = m[p.realPkg] || {};
                setMetaFor(p.realPkg, nc, (ov.section || p.section) === cat ? '未分类' : ov.section);
              });
              noteMetaOnly('删除目录：' + cat);
              if (state.catFilter === cat) state.catFilter = null;
              toast('已加入待提交，请点提交');
            });
          });
      } }
    ];
    openSheet(cat + '/', actions);
  }

  // ---------- plugin actions ----------
  function pluginMenu(path) {
    var p = findPlugin(path);
    if (!p) return;
    var actions = [
      { label: '改名', icon: '✎', fn: function () {
        openDialog('修改插件名称', p.name, '显示名会覆盖 APT 索引里的 Name（需提交才生效）', function (v) {
          v = String(v).trim();
          if (!v || v === p.name) return;
          var e = state.edits.plugins[p.realPkg] = state.edits.plugins[p.realPkg] || {};
          e.name = v;
          noteMetaOnly('改名：' + p.name + ' → ' + v);
          toast('已加入待提交，请点提交');
        });
      } },
      { label: '改图标', icon: '▣', fn: function () { changeIcon(p); } },
      { label: '移动到…', icon: '⇢', fn: function () {
        pickTarget('移动到…', function (t) { applyMove(p, t, false); });
      } },
      { label: '剪切到…', icon: '✂', fn: function () {
        pickTarget('剪切到…', function (t) { applyMove(p, t, true); });
      } },
      { label: '删除', icon: '✕', danger: true, fn: function () {
        var extra = p.iconPath ? '，同时会把 ' + p.iconPath + ' 一起加入待删除（可单独撤销）' : '';
        confirmSheet('删除插件',
          '将删除 ' + p.path + extra + '。此操作不可逆，且需提交后才真正生效。',
          '继续删除', function () { deletePlugin(p); });
      } }
    ];
    openSheet(p.name, actions);
  }

  function applyMove(p, target, isCut) {
    if (target.type === 'cat') {
      setMetaFor(p.realPkg, [target.value], target.value);
      toast((isCut ? '已剪切' : '已移动') + '到「' + target.value + '」，请点提交');
      return;
    }
    var dest = (target.value ? target.value + '/' : '') + basename(p.path);
    if (dest === p.path) return toast('目标与原位置相同', true);
    addPending({ op: 'move', path: p.path, newPath: dest, sha: p.sha, size: p.size, note: p.name });
    if (target.value !== 'debs' && target.value.indexOf('debs/') !== 0) {
      toast('已移动到 ' + target.value + '/，注意：该目录不会被 APT 索引收录', true);
    } else {
      toast('已移动到 ' + target.value + '/，请点提交');
    }
  }

  function changeIcon(p) {
    var input = $('file-icon');
    input.value = '';
    input.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > MAX_BYTES) return toast('图片过大', true);
      var iconPath = 'icons/' + p.realPkg + '.png';
      addPending({
        op: 'add', path: iconPath, file: f,
        size: f.size, note: '改图标 · ' + p.name + ' → ' + iconPath
      });
      var old = state.iconPreviews[iconPath.toLowerCase()];
      if (old) URL.revokeObjectURL(old);
      state.iconPreviews[iconPath.toLowerCase()] = URL.createObjectURL(f);
      rebuild();
      render();
      toast('图标预览已更新（' + iconPath + '），提交后才生效');
    };
    input.click();
  }

  function deletePlugin(p) {
    addPending({ op: 'delete', path: p.path, size: p.size, note: p.name });
    if (p.iconPath && !state.pending.some(function (x) { return x.path === p.iconPath && x.op === 'delete'; })) {
      addPending({ op: 'delete', path: p.iconPath, note: '联动图标（可单独撤销）' });
    }
    toast('已加入待提交，请点提交');
  }

  // ---------- directory actions ----------
  function dirMenu(d) {
    var actions = [
      { label: '重命名目录', icon: '✎', fn: function () {
        openDialog('重命名目录', basename(d), '该目录下全部文件（含子目录）会一起移动，需提交才生效', function (v) {
          var nd = cleanDir(v);
          if (!validDir(nd) || nd === basename(d)) return toast('目录名不合法或未变化', true);
          var parent = dirname(d);
          var target = (parent ? parent + '/' : '') + nd;
          if (target === d) return toast('目录名未变化', true);
          var affected = state.files.filter(function (f) { return f.path.indexOf(d + '/') === 0; });
          if (!affected.length) return toast('该目录下没有文件', true);
          affected.forEach(function (f) {
            addPending({
              op: 'move', path: f.path, newPath: target + f.path.slice(d.length),
              sha: f.sha, size: f.size, note: '目录重命名'
            });
          });
          toast('已加入 ' + affected.length + ' 个移动，请点提交');
        });
      } },
      { label: '在此上传插件', icon: '↑', fn: function () { uploadTo(d, null); } },
      { label: '删除目录', icon: '✕', danger: true, fn: function () {
        var affected = state.files.filter(function (f) { return f.path.indexOf(d + '/') === 0; });
        if (!affected.length) return toast('该目录下没有文件', true);
        confirmSheet('删除目录',
          '将删除 ' + d + '/ 下 ' + affected.length +
          ' 个文件（含子目录里的插件、图标）。此操作不可逆，需提交后才真正生效。',
          '继续', function () {
            openDialog('删除目录', '', '输入目录名「' + basename(d) + '」确认删除', function (v) {
              if (String(v).trim() !== basename(d)) return toast('输入的目录名不一致，已取消', true);
              affected.forEach(function (f) {
                addPending({ op: 'delete', path: f.path, size: f.size, note: '删除目录' });
              });
              toast('已加入 ' + affected.length + ' 个删除，请点提交');
            });
          });
      } }
    ];
    openSheet(d + '/', actions);
  }

  function uploadTo(dir, cat) {
    var input = $('file-deb');
    input.value = '';
    input.onchange = function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      if (!files.length) return;
      var skipped = 0, added = 0;
      files.forEach(function (f) {
        if (f.size > MAX_BYTES) { skipped++; return; }
        var name = String(f.name || 'file').replace(/[\\/]/g, '_');
        addPending({
          op: 'add', path: (dir ? dir + '/' : '') + name, file: f,
          size: f.size, note: '上传插件' + (cat ? ' · 归入 ' + cat : '')
        });
        if (cat) setMetaFor(guessPackage(name), [cat], cat);
        added++;
      });
      if (skipped) toast(skipped + ' 个文件超过 50 MB 已跳过', true);
      else toast('已加入 ' + added + ' 个插件' + (cat ? '（归入 ' + cat + '）' : '') + '，请点提交');
    };
    input.click();
  }

  // ---------- permission self-test ----------
  async function runSelfTest() {
    var box = $('selftest-result');
    if (!box) return;
    var lines = [];
    box.innerHTML = '<p class="hint">正在检测…</p>';
    async function step(name, fn) {
      try { await fn(); lines.push({ name: name, ok: true }); }
      catch (e) { lines.push({ name: name, ok: false, msg: e.message }); }
      box.innerHTML = lines.map(function (l) {
        return '<div class="st-row ' + (l.ok ? 'ok' : 'no') + '"><b>' + (l.ok ? '✓' : '✕') + '</b>' +
          '<span>' + esc(l.name) + (l.msg ? '<small>' + esc(l.msg) + '</small>' : '') + '</span></div>';
      }).join('');
    }
    await step('读取身份 GET /user', function () { return gh('/user'); });
    await step('读取目标仓库 GET /repos/ynyy0/ynyy0.github.io', function () { return gh(repoPath('')); });
    await step('读取分支 GET /git/ref/heads/main', function () { return gh(repoPath('/git/ref/heads/' + BRANCH)); });
    await step('写权限 POST /git/blobs（空 blob，无副作用）', function () {
      return gh(repoPath('/git/blobs'), {
        method: 'POST', body: JSON.stringify({ content: 'Cg==', encoding: 'base64' })
      });
    });
    var bad = lines.filter(function (l) { return !l.ok; });
    box.innerHTML += '<p class="hint">' + (bad.length
      ? '写权限未通过 → 重新生成 PAT：需要 <b>Contents: Read and Write</b>（或 classic 的 <code>repo</code>），然后断开重连。'
      : '全部通过：这个 Token 具备提交所需的读 / 写权限。') + '</p>';
  }

  // ---------- commit ----------
  // 用 API 读取 main 当前 commit 里的 repo-meta.json，避免把浏览器旧快照写回仓库
  async function fetchLatestMeta(parentSha) {
    try {
      var c = await gh(repoPath('/git/commits/' + parentSha));
      var t = await gh(repoPath('/git/trees/' + c.tree.sha));
      var entry = (t.tree || []).find(function (x) { return x.path === 'repo-meta.json'; });
      if (!entry) return { plugins: {} };
      var blob = await gh(repoPath('/git/blobs/' + entry.sha));
      var obj = JSON.parse(b64ToUtf8(blob.content));
      return obj && obj.plugins ? obj : { plugins: {} };
    } catch (e) { return { plugins: {} }; }
  }

  async function commit() {
    if (!state.pending.length) return toast('没有待提交的变更', true);
    var btn = $('btn-commit');
    if (btn) btn.disabled = true;
    toast('正在提交…');
    try {
      for (var i = 0; i < state.pending.length; i++) {
        var p = state.pending[i];
        if (p.op !== 'add' || p.sha) continue;
        if (p.file) {
          toast('上传 ' + basename(p.path) + ' …');
          p.sha = await makeBlobFromBase64(await fileToBase64(p.file));
        } else if (p.text != null) {
          p.sha = await blobFromText(p.text);
        }
      }

      var ref = await gh(repoPath('/git/ref/heads/' + BRANCH));
      var parent = ref.object.sha;
      var map = {};
      state.pending.forEach(function (p) {
        if (p.op === 'add') {
          map[p.path] = { path: p.path, mode: '100644', type: 'blob', sha: p.sha };
        } else if (p.op === 'delete') {
          map[p.path] = { path: p.path, mode: '100644', type: 'blob', sha: null };
        } else if (p.op === 'move') {
          map[p.path] = { path: p.path, mode: '100644', type: 'blob', sha: null };
          map[p.newPath] = { path: p.newPath, mode: '100644', type: 'blob', sha: p.sha };
        }
      });
      if (hasEdits()) {
        var latest = await fetchLatestMeta(parent);
        var finalMeta = mergeMeta(latest, state.edits);
        map['repo-meta.json'] = {
          path: 'repo-meta.json', mode: '100644', type: 'blob',
          sha: await blobFromText(JSON.stringify(finalMeta, null, 2) + '\n')
        };
      }
      var entries = Object.keys(map).map(function (k) { return map[k]; });
      var n = { add: 0, delete: 0, move: 0, meta: 0 };
      state.pending.forEach(function (p) { n[p.op]++; });

      var tree = await gh(repoPath('/git/trees'), {
        method: 'POST', body: JSON.stringify({ base_tree: parent, tree: entries })
      });
      var c = await gh(repoPath('/git/commits'), {
        method: 'POST',
        body: JSON.stringify({
          message: 'Web console: add ' + n.add + ', delete ' + n.delete +
            ', move ' + n.move + ', meta ' + n.meta,
          tree: tree.sha, parents: [parent]
        })
      });
      await gh(repoPath('/git/refs/heads/' + BRANCH), {
        method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false })
      });

      state.pending = [];
      state.commitError = '';
      state.edits = emptyEdits();
      Object.keys(state.iconPreviews).forEach(function (k) { URL.revokeObjectURL(state.iconPreviews[k]); });
      state.iconPreviews = {};
      sessionStorage.removeItem('jbrm_state');
      await loadAll();
      toast('提交成功，改动已生效；索引与站点正在自动更新');
    } catch (e) {
      state.commitError = e.message;
      toast('提交失败，改动未生效（仍保留在待提交）：' + e.message, true);
    } finally {
      if (btn) btn.disabled = false;
      render();
    }
  }

  // ---------- auth ----------
  async function connect() {
    var t = $('token').value.trim();
    if (!t) return setMsg('login-msg', '请填写 Token', true);
    token = t;
    setMsg('login-msg', '正在验证…');
    try {
      var u = await gh('/user');
      if ($('remember').checked) {
        localStorage.setItem('jbrm_token', t);
        sessionStorage.removeItem('jbrm_token');
      } else {
        sessionStorage.setItem('jbrm_token', t);
        localStorage.removeItem('jbrm_token');
      }
      $('login').hidden = true;
      $('main').hidden = false;
      setMsg('login-msg', '');
      state.view = 'dirs';
      state.navDir = '';
      state.catFilter = null;
      await loadAll();
      toast('已连接：' + u.login);
    } catch (e) {
      token = '';
      setMsg('login-msg', '连接失败：' + e.message, true);
    }
  }

  function logout() {
    localStorage.removeItem('jbrm_token');
    sessionStorage.removeItem('jbrm_token');
    token = '';
    $('main').hidden = true;
    $('login').hidden = false;
    $('token').value = '';
    setMsg('login-msg', '已断开（未提交改动仍保留）');
  }

  // ---------- bindings ----------
  $('btn-connect').onclick = connect;
  $('token').onkeydown = function (e) { if (e.key === 'Enter') connect(); };
  $('search').oninput = render;
  $('search-clear').onclick = function () { $('search').value = ''; render(); };
  $('dirty-go').onclick = function () {
    state.view = 'pending'; render(); window.scrollTo(0, 0);
  };

  document.querySelectorAll('.tab').forEach(function (t) {
    t.onclick = function () {
      state.view = t.getAttribute('data-tab');
      state.navDir = '';
      state.catFilter = null;
      $('search').value = '';
      render();
      window.scrollTo(0, 0);
    };
  });

  $('nav-back').onclick = function () {
    if (state.view === 'dirs') state.navDir = dirname(state.navDir);
    else if (state.view === 'plugins') state.catFilter = null;
    $('search').value = ''; render();
  };

  $('nav-add').onclick = function () {
    if (state.view === 'pending') {
      state.pending = []; state.edits = emptyEdits(); rebuild(); render(); toast('已清空');
    } else if (state.view === 'dirs') {
      openDialog('添加目录', '', state.navDir
        ? '在 ' + state.navDir + '/ 下新建目录（需提交才生效）' : '在仓库根目录下新建目录（需提交才生效）', function (v) {
        var d = cleanDir(v);
        if (!validDir(d)) return toast('目录名不合法', true);
        var full = (state.navDir ? state.navDir + '/' : '') + d;
        if (allDirs().indexOf(full) >= 0) return toast('目录已存在', true);
        addPending({ op: 'add', path: full + '/.gitkeep', text: '\n', note: '新建目录' });
        toast('已加入待提交，请点提交');
      });
    } else if (state.view === 'plugins') {
      if (!state.catFilter) return addCategory();
      if (state.catFilter === '__all__') return uploadTo('debs', '未分类');
      uploadTo('debs', state.catFilter);
    }
  };

  $('view-dirs').onclick = function (e) {
    var img = e.target.closest('[data-icon]');
    if (img) {
      $('img-viewer-src').src = img.getAttribute('data-icon');
      $('img-viewer-name').textContent = img.getAttribute('data-iconname');
      $('img-viewer').hidden = false;
      return;
    }
    var menu = e.target.closest('[data-dirmenu]');
    if (menu) { e.stopPropagation(); return dirMenu(menu.getAttribute('data-dirmenu')); }
    var plugin = e.target.closest('[data-plugin]');
    if (plugin) return pluginMenu(plugin.getAttribute('data-plugin'));
    var cell = e.target.closest('[data-open]');
    if (!cell) return;
    state.navDir = cell.getAttribute('data-open');
    $('search').value = '';
    render();
    window.scrollTo(0, 0);
  };

  $('view-plugins').onclick = function (e) {
    var menu = e.target.closest('[data-catmenu]');
    if (menu) { e.stopPropagation(); return catMenu(menu.getAttribute('data-catmenu')); }
    var plugin = e.target.closest('[data-plugin]');
    if (plugin) return pluginMenu(plugin.getAttribute('data-plugin'));
    var catCell = e.target.closest('[data-cat]');
    if (catCell) {
      state.catFilter = catCell.getAttribute('data-cat');
      $('search').value = '';
      render();
      window.scrollTo(0, 0);
    }
  };

  $('view-pending').onclick = function (e) {
    var id = e.target.getAttribute('data-undo');
    if (id) removePending(id);
  };

  $('img-viewer-close').onclick = function () { $('img-viewer').hidden = true; };
  $('img-viewer').onclick = function (e) {
    if (e.target === $('img-viewer')) $('img-viewer').hidden = true;
  };

  $('sheet-actions').onclick = function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var a = sheetActions[Number(btn.getAttribute('data-act'))];
    closeSheet();
    if (a && a.fn) setTimeout(a.fn, 30);
  };
  $('sheet-cancel').onclick = closeSheet;
  $('sheet').onclick = function (e) { if (e.target === $('sheet')) closeSheet(); };
  $('dialog-cancel').onclick = closeDialog;
  $('dialog-ok').onclick = function () {
    var v = $('dialog-input').value;
    var cb = dialogCb;
    closeDialog();
    if (cb) cb(v);
  };
  $('dialog-input').onkeydown = function (e) { if (e.key === 'Enter') $('dialog-ok').click(); };
  $('dialog').onclick = function (e) { if (e.target === $('dialog')) closeDialog(); };

  restoreState();
  var saved = localStorage.getItem('jbrm_token') || sessionStorage.getItem('jbrm_token');
  if (saved) { $('token').value = saved; connect(); }
})();
