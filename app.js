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
    index: { byFilename: {}, byPackage: {} },
    meta: { plugins: {} },
    metaDirty: false,
    plugins: [],
    pending: [],
    commitError: '',
    view: 'dirs',
    navDir: '',          // 目录页当前浏览路径（'' = 仓库根）
    catFilter: null      // null = 分类列表；'__all__' = 全部插件；其它 = 某分类
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
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
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
      if (r.status === 401) {
        throw new Error('Token 无效或已过期，请重新生成并重新连接。');
      }
      if (r.status === 409) {
        throw new Error('提交冲突：期间仓库有新提交（通常是自动索引）。请点「刷新仓库」后重试。');
      }
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
    state.files.forEach(function (f) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(f.path)) state.iconIndex[f.path.toLowerCase()] = f.path;
    });

    try {
      var r = await fetch(rawUrl('Packages') + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) state.index = parseIndex(await r.text());
    } catch (e) { /* 索引不可用时退化为文件名显示 */ }

    // 有未提交的改名时保留内存里的元数据，避免「断开重连」把它冲掉
    if (!state.metaDirty) {
      var metaFile = state.files.find(function (f) { return f.path === 'repo-meta.json'; });
      if (metaFile) {
        try {
          var blob = await gh(repoPath('/git/blobs/' + metaFile.sha));
          var parsed = JSON.parse(b64ToUtf8(blob.content));
          state.meta = parsed && parsed.plugins ? parsed : { plugins: {} };
        } catch (e) { state.meta = { plugins: {} }; }
      } else {
        state.meta = { plugins: {} };
      }
    }
    rebuild();
    toast('已加载 ' + state.plugins.length + ' 个插件');
  }

  function rebuild() {
    var iconIndex = state.iconIndex;
    var meta = state.meta.plugins || {};
    state.plugins = state.files.filter(function (f) {
      return /\.deb$/i.test(f.path);
    }).map(function (f) {
      var pkg = guessPackage(basename(f.path));
      var info = state.index.byFilename[f.path] || state.index.byPackage[pkg] || {};
      var ov = meta[pkg] || {};
      var realPkg = info.Package || pkg; // deb control 里的真实包标识符
      var wantIcon = 'icons/' + realPkg + '.png';
      var localIcon = iconIndex[wantIcon.toLowerCase()] || null;
      var icon = ov.icon || (localIcon ? localIcon :
        (info.Icon && /^https?:/.test(info.Icon) ? info.Icon : 'CydiaIcon.png'));
      return {
        path: f.path, dir: dirname(f.path), sha: f.sha, size: f.size, pkg: pkg,
        realPkg: realPkg,
        name: ov.name || info.Name || pkg,
        version: info.Version || '',
        desc: ov.description || info.Description || '',
        section: info.Section || '',
        icon: icon,
        iconUrl: /^https?:/.test(icon) ? icon : rawUrl(icon),
        iconPath: localIcon
      };
    });
  }

  function findPlugin(path) {
    return state.plugins.find(function (p) { return p.path === path; });
  }

  // ---------- 分类（分组）模型 ----------
  // 分类存在 repo-meta.json：categories=[...]，plugins[pkg].cats=[...]、plugins[pkg].section=...
  // deb 文件位置不变，APT 索引通过 section 覆盖体现分类。
  function pluginCats(p) {
    var ov = (state.meta.plugins || {})[p.pkg] || {};
    if (ov.cats && ov.cats.length) return ov.cats.slice();
    return [ov.section || p.section || '未分类'];
  }
  function pluginsInCat(cat) {
    return state.plugins.filter(function (p) { return pluginCats(p).indexOf(cat) >= 0; });
  }
  function categories() {
    if (Array.isArray(state.meta.categories)) return state.meta.categories.slice();
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
    state.meta.categories = list;
    state.metaDirty = true;
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
    // 同一路径的重复新增直接替换（改图标「如有重复直接替换」）
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
  // 元数据变更只保留一条待提交记录
  function noteMetaOnly(text) {
    state.metaDirty = true;
    var exist = state.pending.find(function (p) { return p.op === 'meta'; });
    if (exist) {
      exist.text = text;
      render();
    } else {
      addPending({ op: 'meta', text: text });
    }
  }
  function setMetaFor(pkg, cats, section) {
    state.meta.plugins = state.meta.plugins || {};
    var ov = state.meta.plugins[pkg] = state.meta.plugins[pkg] || {};
    ov.cats = cats.slice();
    if (section) ov.section = section;
    noteMetaOnly('元数据：' + pkg + ' → ' + cats.join(' / '));
  }

  // ---------- session persistence (survives a page refresh) ----------
  function saveState() {
    try {
      var keep = state.pending.filter(function (p) { return !p.file; }).map(function (p) {
        return {
          id: p.id, op: p.op, path: p.path, newPath: p.newPath, sha: p.sha,
          text: p.text, size: p.size, note: p.note
        };
      });
      sessionStorage.setItem('jbrm_state', JSON.stringify({
        pending: keep, meta: state.meta, metaDirty: state.metaDirty,
        commitError: state.commitError
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function restoreState() {
    try {
      var raw = sessionStorage.getItem('jbrm_state');
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.pending && s.pending.length) state.pending = s.pending;
      if (s.meta && s.meta.plugins) {
        state.meta = s.meta;
        state.metaDirty = !!s.metaDirty;
      }
      state.commitError = s.commitError || '';
      seq = state.pending.reduce(function (m, p) {
        return Math.max(m, Number(p.id) || 0);
      }, 0);
    } catch (e) { /* ignore */ }
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
      ? (!state.catFilter ? '分类' :
         (state.catFilter === '__all__' ? '全部插件' : state.catFilter))
      : titles[v];
    $('nav-add').textContent = '+';

    var searchable = (v === 'dirs' || v === 'plugins');
    $('search').parentNode.hidden = !searchable;
    $('search').placeholder = v === 'dirs' ? '搜索目录 / 插件'
      : (state.catFilter ? '搜索插件' : '搜索分类');

    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === v);
    });
    var n = state.pending.length;
    var badge = $('tab-badge');
    badge.hidden = n === 0;
    badge.textContent = n;

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
        'onerror="this.onerror=null;this.src=\'' + esc(rawUrl('CydiaIcon.png')) + '\'">' +
        '<div class="pinfo"><div class="pname">' + esc(p.name) + '</div>' +
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

    if (directDebs.length) {
      html += '<div class="section-title">本目录插件 · ' + directDebs.length + ' 个</div>';
      html += pluginCards(directDebs);
    }
    if (otherFiles.length) {
      html += '<div class="card"><b>其它文件</b><p class="hint">' + otherFiles.length +
        ' 个（图标、索引、页面等）</p></div>';
    }
    if (!q && !cur) {
      html += '<div class="card"><b>提示</b><p class="hint">点目录行进入子目录，可逐级浏览；' +
        '点 ⋯ 可重命名、删除目录或在此上传插件。右上角 + 在当前目录下新建目录。</p></div>';
    }
    $('view-dirs').innerHTML = html;
  }

  function renderCats(q) {
    var names = categories().filter(function (c) {
      return !q || c.toLowerCase().indexOf(q) >= 0;
    });
    var html = '<div class="section-title">分类目录 · ' + names.length + ' 个</div><div class="list-card">';
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
    html += '<div class="card"><b>提示</b><p class="hint">右上角 + 添加目录；点分类行的 ⋯ 可重命名、删除目录。' +
      '插件归类只记录归属，不会改动 deb 文件位置，越狱源不受影响。</p></div>';
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
    if (!list.length) {
      html += '<div class="empty">这里还没有插件</div>';
    } else {
      html += pluginCards(list);
    }
    $('view-plugins').innerHTML = html;
  }

  function renderPending() {
    var label = { add: '新增', delete: '删除', move: '移动', meta: '元数据' };
    var cls = { add: 'add', delete: 'del', move: 'mov', meta: 'meta' };
    var html = '<div class="stat"><div><b>' + state.plugins.length + '</b><span>插件</span></div>' +
      '<div><b>' + categories().length + '</b><span>分类</span></div>' +
      '<div><b>' + state.pending.length + '</b><span>待提交</span></div></div>';
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
      html += '<div class="card err-card"><b>提交失败</b>' +
        '<p class="hint err-text">' + esc(state.commitError) + '</p>' +
        '<p class="hint"><b>怎么修</b><br>' +
        '① GitHub → Settings → Developer settings → Personal access tokens<br>' +
        '② 新建 Token：<b>fine-grained</b> 要选 Resource owner <code>ynyy0</code>、仓库 <code>ynyy0.github.io</code>、权限 <b>Contents: Read and Write</b>；<b>classic</b> 直接勾 <code>repo</code><br>' +
        '③ 回「连接」页 → 断开 → 粘贴新 Token 重新连接<br>' +
        '④ 回来重新提交（待提交的改动不会丢）</p>' +
        '<div class="row" style="margin-top:12px">' +
        '<a class="btn grow linkbtn" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">生成新 PAT ↗</a>' +
        '<button id="btn-selftest2" class="btn grow">权限自检</button></div></div>';
    }
    html += '<div class="commit-bar"><button id="btn-commit" class="btn primary block"' +
      (state.pending.length ? '' : ' disabled') + '>提交更改（' + state.pending.length + '）</button>' +
      '<button id="btn-clear" class="btn block"' + (state.pending.length ? '' : ' disabled') +
      ' style="margin-top:9px">清空待提交</button>' +
      '<p class="hint">所有变更合并为一次原子提交；提交后源仓库会自动刷新索引并部署。</p></div>';
    $('view-pending').innerHTML = html;
    $('btn-commit').onclick = commit;
    $('btn-clear').onclick = function () {
      state.pending = []; rebuild(); render(); toast('已清空');
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
      '<div id="selftest-result"></div></div>' +
      '<div class="card"><b>使用说明</b><p class="hint">' +
      '① 目录页逐级进入子目录，点 ⋯ 可重命名 / 删除目录、在此上传；<br>' +
      '② 全部插件页是分类目录，右上角 + 添加目录，分类 ⋯ 可重命名 / 删除；<br>' +
      '③ 分类内 + 上传的插件默认归到该分类；插件 ⋯ 可移动到… / 复制到… / 剪切到… 选分类；<br>' +
      '④ 改图标自动存成 <code>icons/包标识符.png</code>，重名直接替换；<br>' +
      '⑤ 单文件建议 ≤ 50 MB，移出 <code>debs/</code> 的插件不会被索引收录。</p></div>' +
      '<div class="card"><b>关于 Token</b><p class="hint">只保存在本机浏览器，随请求直发 api.github.com，' +
      '不写入仓库、不经过第三方。可随时「断开」清除。</p></div>';
    $('btn-refresh2').onclick = function () {
      loadAll().then(function () { render(); }).catch(function (e) { toast('刷新失败：' + e.message, true); });
    };
    $('btn-logout').onclick = logout;
    $('btn-selftest').onclick = runSelfTest;
  }

  // ---------- sheets & dialogs ----------
  var sheetActions = [];
  function openSheet(title, actions) {
    sheetActions = actions;
    $('sheet-title').textContent = title;
    $('sheet-actions').innerHTML = actions.map(function (a, i) {
      return '<button class="' + (a.danger ? 'danger' : '') + '" data-act="' + i + '">' +
        '<span class="si">' + (a.icon || '•') + '</span><span>' + esc(a.label) + '</span></button>';
    }).join('');
    $('sheet').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; }

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

  // 目标目录 = 全部插件页的分类列表
  function pickCat(title, cb) {
    var list = categories();
    if (list.indexOf('未分类') < 0) list.push('未分类');
    var actions = list.map(function (c) {
      return { label: c + '/', icon: '▸', fn: function () { cb(c); } };
    });
    actions.push({
      label: '新建目录…', icon: '+', fn: function () {
        openDialog('新建分类目录', '', '输入目录名，然后直接选它', function (v) {
          var name = String(v).trim();
          if (!name) return toast('目录名不能为空', true);
          var cs = categories();
          if (cs.indexOf(name) < 0) { cs.push(name); setCategories(cs); }
          cb(name);
        });
      }
    });
    openSheet(title, actions);
  }

  // ---------- 分类目录操作 ----------
  function addCategory() {
    openDialog('添加目录', '', '输入分类目录名（插件可归类到这个目录）', function (v) {
      var name = String(v).trim();
      if (!name) return toast('目录名不能为空', true);
      var cs = categories();
      if (cs.indexOf(name) >= 0) return toast('目录已存在', true);
      cs.push(name);
      setCategories(cs);
      toast('已添加目录「' + name + '」');
    });
  }

  function catMenu(cat) {
    var actions = [
      { label: '重命名目录', icon: '✎', fn: function () {
        openDialog('重命名目录', cat, '该分类下 ' + pluginsInCat(cat).length +
          ' 个插件会一起归到新名称', function (v) {
          var nw = String(v).trim();
          if (!nw || nw === cat) return toast('名称不合法或未变化', true);
          var cs = categories();
          if (cs.indexOf(nw) >= 0 && nw !== cat) return toast('目录已存在', true);
          cs = cs.map(function (c) { return c === cat ? nw : c; });
          state.meta.categories = cs;
          state.plugins.forEach(function (p) {
            var pc = pluginCats(p);
            if (pc.indexOf(cat) < 0) return;
            var nc = pc.map(function (c) { return c === cat ? nw : c; });
            var ov = (state.meta.plugins || {})[p.pkg] || {};
            setMetaFor(p.pkg, nc, (ov.section || p.section) === cat ? nw : ov.section);
          });
          noteMetaOnly('重命名目录：' + cat + ' → ' + nw);
          if (state.catFilter === cat) state.catFilter = nw;
          toast('已重命名，插件归类已更新');
        });
      } },
      { label: '删除目录', icon: '✕', danger: true, fn: function () {
        openDialog('删除目录', '', '将移除「' + cat + '」分组，组内 ' + pluginsInCat(cat).length +
          ' 个插件归入「未分类」（不会删除 deb 文件）。输入目录名确认', function (v) {
          if (String(v).trim() !== cat) return toast('输入的目录名不一致，已取消', true);
          var cs = categories().filter(function (c) { return c !== cat; });
          if (cs.indexOf('未分类') < 0) cs.push('未分类');
          state.meta.categories = cs;
          state.plugins.forEach(function (p) {
            var pc = pluginCats(p);
            if (pc.indexOf(cat) < 0) return;
            var nc = pc.filter(function (c) { return c !== cat; });
            if (!nc.length) nc = ['未分类'];
            var ov = (state.meta.plugins || {})[p.pkg] || {};
            setMetaFor(p.pkg, nc, (ov.section || p.section) === cat ? '未分类' : ov.section);
          });
          noteMetaOnly('删除目录：' + cat);
          if (state.catFilter === cat) state.catFilter = null;
          toast('目录已移除，插件归入未分类');
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
        openDialog('修改插件名称', p.name, '显示名会覆盖 APT 索引里的 Name', function (v) {
          v = String(v).trim();
          if (!v || v === p.name) return;
          state.meta.plugins = state.meta.plugins || {};
          state.meta.plugins[p.pkg] = state.meta.plugins[p.pkg] || {};
          state.meta.plugins[p.pkg].name = v;
          noteMetaOnly('改名：' + p.name + ' → ' + v);
          toast('已加入待提交');
        });
      } },
      { label: '改图标', icon: '▣', fn: function () { changeIcon(p); } },
      { label: '移动到…', icon: '⇢', fn: function () {
        pickCat('移动到哪个分类目录', function (cat) {
          setMetaFor(p.pkg, [cat], cat);
          toast('已归到「' + cat + '」，原分类不再显示');
        });
      } },
      { label: '复制到…', icon: '⧉', fn: function () {
        pickCat('复制到哪个分类目录（保留原分类）', function (cat) {
          var pc = pluginCats(p);
          if (pc.indexOf(cat) >= 0) return toast('该插件已在此分类下', true);
          setMetaFor(p.pkg, pc.concat([cat]), undefined);
          toast('已同时归到「' + cat + '」');
        });
      } },
      { label: '剪切到…', icon: '✂', fn: function () {
        pickCat('剪切到哪个分类目录', function (cat) {
          setMetaFor(p.pkg, [cat], cat);
          toast('已剪切到「' + cat + '」');
        });
      } },
      { label: '删除', icon: '✕', danger: true, fn: function () { deletePlugin(p); } }
    ];
    openSheet(p.name, actions);
  }

  function changeIcon(p) {
    var input = $('file-icon');
    input.value = '';
    input.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > MAX_BYTES) return toast('图片过大', true);
      // 图标统一命名：icons/包标识符.png（真实 deb control Package），重名直接替换
      var iconPath = 'icons/' + (p.realPkg || p.pkg) + '.png';
      addPending({
        op: 'add', path: iconPath, file: f,
        size: f.size, note: '改图标 · ' + p.name + ' → ' + iconPath
      });
      var cur = findPlugin(p.path);
      if (cur) cur.iconUrl = URL.createObjectURL(f);
      render();
      toast('新图标已加入待提交（' + iconPath + '）');
    };
    input.click();
  }

  function deletePlugin(p) {
    addPending({ op: 'delete', path: p.path, size: p.size, note: p.name });
    if (p.iconPath && !state.pending.some(function (x) { return x.path === p.iconPath && x.op === 'delete'; })) {
      addPending({ op: 'delete', path: p.iconPath, note: '联动图标（可单独撤销）' });
    }
    toast('已加入待提交');
  }

  // ---------- directory actions ----------
  function dirMenu(d) {
    var actions = [
      { label: '重命名目录', icon: '✎', fn: function () {
        openDialog('重命名目录', basename(d), '该目录下全部文件（含子目录）会一起移动', function (v) {
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
          toast('已加入 ' + affected.length + ' 个移动');
        });
      } },
      { label: '在此上传插件', icon: '↑', fn: function () { uploadTo(d, null); } },
      { label: '删除目录', icon: '✕', danger: true, fn: function () {
        var affected = state.files.filter(function (f) { return f.path.indexOf(d + '/') === 0; });
        if (!affected.length) return toast('该目录下没有文件', true);
        openDialog('删除目录', '', '将删除 ' + d + '/ 下 ' + affected.length +
          ' 个文件，输入目录名确认', function (v) {
          if (String(v).trim() !== basename(d)) return toast('输入的目录名不一致，已取消', true);
          affected.forEach(function (f) {
            addPending({ op: 'delete', path: f.path, size: f.size, note: '删除目录' });
          });
          toast('已加入 ' + affected.length + ' 个删除');
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
        if (cat) {
          // 上传后默认归到当前分类目录（deb 仍在 debs/ 下，索引不受影响）
          setMetaFor(guessPackage(name), [cat], cat);
        }
        added++;
      });
      if (skipped) toast(skipped + ' 个文件超过 50 MB 已跳过', true);
      else toast('已加入 ' + added + ' 个插件' + (cat ? '（归入 ' + cat + '）' : ''));
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
      try {
        await fn();
        lines.push({ name: name, ok: true });
      } catch (e) {
        lines.push({ name: name, ok: false, msg: e.message });
      }
      box.innerHTML = lines.map(function (l) {
        return '<div class="st-row ' + (l.ok ? 'ok' : 'no') + '"><b>' + (l.ok ? '✓' : '✕') + '</b>' +
          '<span>' + esc(l.name) + (l.msg ? '<small>' + esc(l.msg) + '</small>' : '') + '</span></div>';
      }).join('');
    }
    await step('读取身份 GET /user', function () { return gh('/user'); });
    await step('读取目标仓库 GET /repos/ynyy0/ynyy0.github.io', function () { return gh(repoPath('')); });
    await step('读取分支 GET /git/ref/heads/main', function () {
      return gh(repoPath('/git/ref/heads/' + BRANCH));
    });
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
      if (state.metaDirty) {
        map['repo-meta.json'] = {
          path: 'repo-meta.json', mode: '100644', type: 'blob',
          sha: await blobFromText(JSON.stringify(state.meta, null, 2) + '\n')
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
      state.metaDirty = false;
      await loadAll();
      render();
      toast('提交成功，索引与站点正在自动更新');
    } catch (e) {
      state.commitError = e.message;
      toast('提交失败：' + e.message, true);
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
      render();
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
    // 保留待提交改动与未提交的元数据，方便换 Token 后继续提交
    $('main').hidden = true;
    $('login').hidden = false;
    $('token').value = '';
    setMsg('login-msg', '已断开');
  }

  // ---------- bindings ----------
  $('btn-connect').onclick = connect;
  $('token').onkeydown = function (e) { if (e.key === 'Enter') connect(); };
  $('search').oninput = render;
  $('search-clear').onclick = function () { $('search').value = ''; render(); };

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
    if (state.view === 'dirs') {
      state.navDir = dirname(state.navDir);
    } else if (state.view === 'plugins') {
      state.catFilter = null; // 回到分类目录列表
    }
    $('search').value = ''; render();
  };

  $('nav-add').onclick = function () {
    if (state.view === 'pending') {
      state.pending = []; rebuild(); render(); toast('已清空');
    } else if (state.view === 'dirs') {
      openDialog('添加目录', '', state.navDir
        ? '在 ' + state.navDir + '/ 下新建目录' : '在仓库根目录下新建目录', function (v) {
        var d = cleanDir(v);
        if (!validDir(d)) return toast('目录名不合法', true);
        var full = (state.navDir ? state.navDir + '/' : '') + d;
        if (allDirs().indexOf(full) >= 0) return toast('目录已存在', true);
        addPending({ op: 'add', path: full + '/.gitkeep', text: '\n', note: '新建目录' });
        toast('目录已加入待提交');
      });
    } else if (state.view === 'plugins') {
      if (!state.catFilter) return addCategory(); // 分类列表页：添加目录
      if (state.catFilter === '__all__') return uploadTo('debs', '未分类');
      uploadTo('debs', state.catFilter);          // 分类内：上传插件并归入该分类
    }
  };

  $('view-dirs').onclick = function (e) {
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
