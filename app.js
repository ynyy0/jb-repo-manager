(function () {
  'use strict';

  var API = 'https://api.github.com';
  var OWNER = 'ynyy0';
  var REPO = 'ynyy0.github.io';
  var BRANCH = 'main';
  var MAX_BYTES = 50 * 1024 * 1024;

  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  var items = [];    // {path, sha, size}
  var pending = [];  // {id, op, path, newPath, sha, file, size, note}
  var seq = 0;
  var toastTimer = null;

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

  function toast(text, isErr) {
    var el = $('toast');
    el.textContent = text;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2800);
  }

  function setMsg(id, text, isErr, isHtml) {
    var el = $(id);
    el.className = 'msg' + (isErr ? ' err' : (text ? ' ok' : ''));
    if (isHtml) el.innerHTML = text; else el.textContent = text;
  }

  async function gh(path, opts) {
    opts = opts || {};
    var headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    var r = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body || undefined
    });
    if (!r.ok) {
      var detail = '';
      try { var j = await r.json(); detail = j.message || ''; } catch (e) { /* ignore */ }
      throw new Error(r.status + ' ' + r.statusText + (detail ? ' — ' + detail : ''));
    }
    return r.status === 204 ? null : r.json();
  }

  function repoPath(suffix) { return '/repos/' + OWNER + '/' + REPO + suffix; }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  // deb 文件名 -> 包名：com.foo_1.2_iphoneos-arm64.deb => com.foo
  function guessPackage(fn) {
    var s = fn.replace(/\.deb$/i, '').replace(/_iphoneos-arm64e?$/i, '');
    var i = s.lastIndexOf('_');
    return i > 0 ? s.slice(0, i) : s;
  }

  function allDirs() {
    var set = {};
    set[''] = 1;
    items.forEach(function (i) { set[dirname(i.path)] = 1; });
    pending.forEach(function (p) {
      if (p.op === 'add') set[dirname(p.path)] = 1;
      if (p.op === 'move') set[dirname(p.newPath)] = 1;
    });
    return Object.keys(set).sort();
  }

  function setSelect(id, opts) {
    var el = $(id);
    var cur = el.value;
    el.innerHTML = opts.map(function (o) {
      return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
    }).join('');
    if (opts.some(function (o) { return o.value === cur; })) el.value = cur;
  }

  function renderSelects() {
    var dirOpts = allDirs().map(function (d) {
      return { value: d, label: d === '' ? '（仓库根目录）' : d + '/' };
    });
    setSelect('upload-dir', dirOpts);
    setSelect('move-dir', dirOpts);
    setSelect('rename-old', dirOpts.filter(function (o) { return o.value !== ''; }));
    setSelect('move-file', items.map(function (i) {
      return { value: i.path, label: i.path };
    }));
  }

  function renderTree() {
    var q = $('filter').value.trim().toLowerCase();
    var groups = {};
    items.forEach(function (i) {
      if (q && i.path.toLowerCase().indexOf(q) < 0) return;
      var d = dirname(i.path);
      (groups[d] = groups[d] || []).push(i);
    });
    var keys = Object.keys(groups).sort();
    var html = '';
    keys.forEach(function (d) {
      html += '<div class="dir">' + (d === '' ? '（根目录）' : esc(d) + '/') +
        ' <span class="muted">· ' + groups[d].length + ' 个文件</span></div>';
      groups[d].forEach(function (i) {
        html += '<div class="filerow"><span class="name">' + esc(basename(i.path)) + '</span>' +
          '<span class="sz">' + fmtSize(i.size) + '</span>' +
          '<button class="mini" data-move="' + esc(i.path) + '">移动</button>' +
          '<button class="mini del" data-del="' + esc(i.path) + '">删除</button></div>';
      });
    });
    $('tree').innerHTML = html || '<div class="item muted">没有匹配的文件</div>';
    $('file-count').textContent = items.length + ' 个文件';
    $('tree-summary').textContent = items.length + ' 个文件 · ' + (allDirs().length - 1) + ' 个目录';
  }

  function renderPending() {
    var n = pending.length;
    $('pending-count').textContent = n;
    $('pending-count2').textContent = n;
    $('btn-commit').disabled = n === 0;
    var label = { add: '上传', delete: '删除', move: '移动' };
    var cls = { add: 'add', delete: 'del', move: 'mov' };
    $('pending').innerHTML = n ? pending.map(function (p) {
      var text = p.op === 'move' ? p.path + ' → ' + p.newPath : p.path;
      return '<div class="item"><span class="tag ' + cls[p.op] + '">' + label[p.op] + '</span>' +
        '<span class="name">' + esc(text) +
        (p.note ? ' <span class="muted">(' + esc(p.note) + ')</span>' : '') + '</span>' +
        '<span class="sz">' + (p.size ? fmtSize(p.size) : '') + '</span>' +
        '<button class="mini del" data-undo="' + p.id + '">撤销</button></div>';
    }).join('') : '<div class="item muted">还没有变更</div>';
  }

  function renderAll() { renderSelects(); renderTree(); renderPending(); }

  async function loadTree() {
    toast('读取仓库文件…');
    var ref = await gh(repoPath('/git/ref/heads/' + BRANCH));
    var t = await gh(repoPath('/git/trees/' + ref.object.sha + '?recursive=1'));
    if (t.truncated) toast('GitHub 返回的文件树被截断，操作可能不完整', true);
    items = t.tree.filter(function (x) { return x.type === 'blob'; }).map(function (x) {
      return { path: x.path, sha: x.sha, size: x.size || 0 };
    });
    renderAll();
    toast('已加载 ' + items.length + ' 个文件');
  }

  function addDelete(path) {
    var it = items.find(function (x) { return x.path === path; });
    if (!it) return;
    if (pending.some(function (p) { return p.path === path && p.op === 'delete'; })) {
      return toast('这个文件已经在待删除列表里', true);
    }
    pending.push({ id: ++seq, op: 'delete', path: path, size: it.size });
    if (path.indexOf('debs/') === 0 && /\.deb$/i.test(path)) {
      var iconPath = 'icons/' + guessPackage(basename(path)) + '.png';
      var icon = items.find(function (x) { return x.path.toLowerCase() === iconPath.toLowerCase(); });
      if (icon && !pending.some(function (p) { return p.path === icon.path && p.op === 'delete'; })) {
        pending.push({ id: ++seq, op: 'delete', path: icon.path, size: icon.size, note: '联动图标' });
      }
    }
    renderAll();
  }

  function addMove() {
    var src = $('move-file').value;
    var destDir = $('move-dir').value;
    if (!src) return toast('请先选择要移动的文件', true);
    var it = items.find(function (x) { return x.path === src; });
    if (!it) return toast('文件不存在，请先刷新', true);
    var dest = (destDir ? destDir + '/' : '') + basename(src);
    if (dest === src) return toast('目标位置与原位置相同', true);
    pending.push({ id: ++seq, op: 'move', path: src, newPath: dest, sha: it.sha, size: it.size });

    if ($('move-icon').checked && /\.deb$/i.test(src)) {
      var sibling = dirname(src) + '/' + guessPackage(basename(src)) + '.png';
      var ic = items.find(function (x) { return x.path === sibling; });
      if (ic && !pending.some(function (p) { return p.path === ic.path; })) {
        pending.push({
          id: ++seq, op: 'move', path: ic.path,
          newPath: (destDir ? destDir + '/' : '') + basename(ic.path),
          sha: ic.sha, size: ic.size, note: '同名图标'
        });
      }
    }
    renderAll();
    toast('已加入待提交');
  }

  function renameDir() {
    var oldD = $('rename-old').value;
    var newD = cleanDir($('rename-new').value);
    if (!oldD || !newD) return toast('请选择原目录并填写新名称', true);
    if (oldD === newD) return toast('目录名没有变化', true);
    if (/\\/.test(newD) || newD.indexOf('..') >= 0) return toast('目录名不合法', true);
    var affected = items.filter(function (i) { return i.path.indexOf(oldD + '/') === 0; });
    if (!affected.length) return toast('该目录下没有文件', true);
    affected.forEach(function (i) {
      pending.push({
        id: ++seq, op: 'move', path: i.path,
        newPath: newD + i.path.slice(oldD.length), sha: i.sha,
        size: i.size, note: '目录重命名'
      });
    });
    renderAll();
    toast('已加入 ' + affected.length + ' 个文件的移动');
  }

  async function handleFiles(fileList) {
    var raw = cleanDir($('new-dir').value) || $('upload-dir').value || '';
    if (/\\/.test(raw) || raw.indexOf('..') >= 0) return toast('目录名不合法', true);
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    for (var k = 0; k < files.length; k++) {
      var f = files[k];
      if (f.size > MAX_BYTES) { toast(f.name + ' 超过 50 MB，已跳过', true); continue; }
      var name = String(f.name || 'file').replace(/[\\/]/g, '_');
      var path = (raw ? raw + '/' : '') + name;
      pending = pending.filter(function (p) { return !(p.path === path && p.op === 'add'); });
      pending.push({
        id: ++seq, op: 'add', path: path, file: f, size: f.size,
        note: items.some(function (i) { return i.path === path; }) ? '覆盖已有' : ''
      });
    }
    $('file-input').value = '';
    renderAll();
    toast('已加入 ' + files.length + ' 个文件，点「提交更改」后才写入仓库');
  }

  function summarize(ps) {
    var n = { add: 0, delete: 0, move: 0 };
    ps.forEach(function (p) { n[p.op]++; });
    return 'upload ' + n.add + ', delete ' + n.delete + ', move ' + n.move;
  }

  async function commit() {
    if (!pending.length) return toast('没有待提交的变更', true);
    var btn = $('btn-commit');
    btn.disabled = true;
    setMsg('commit-msg', '正在提交…', false);
    try {
      for (var i = 0; i < pending.length; i++) {
        var p = pending[i];
        if (p.op === 'add' && p.file && !p.sha) {
          toast('上传 ' + basename(p.path) + ' …');
          var b64 = await fileToBase64(p.file);
          var blob = await gh(repoPath('/git/blobs'), {
            method: 'POST',
            body: JSON.stringify({ content: b64, encoding: 'base64' })
          });
          p.sha = blob.sha;
        }
      }

      var ref = await gh(repoPath('/git/ref/heads/' + BRANCH));
      var parent = ref.object.sha;
      var map = {};
      pending.forEach(function (p) {
        if (p.op === 'add') {
          map[p.path] = { path: p.path, mode: '100644', type: 'blob', sha: p.sha };
        } else if (p.op === 'delete') {
          map[p.path] = { path: p.path, mode: '100644', type: 'blob', sha: null };
        } else if (p.op === 'move') {
          map[p.path] = { path: p.path, mode: '100644', type: 'blob', sha: null };
          map[p.newPath] = { path: p.newPath, mode: '100644', type: 'blob', sha: p.sha };
        }
      });
      var entries = Object.keys(map).map(function (k) { return map[k]; });

      var tree = await gh(repoPath('/git/trees'), {
        method: 'POST',
        body: JSON.stringify({ base_tree: parent, tree: entries })
      });
      var c = await gh(repoPath('/git/commits'), {
        method: 'POST',
        body: JSON.stringify({
          message: 'Web console: ' + summarize(pending),
          tree: tree.sha,
          parents: [parent]
        })
      });
      await gh(repoPath('/git/refs/heads/' + BRANCH), {
        method: 'PATCH',
        body: JSON.stringify({ sha: c.sha, force: false })
      });

      var url = 'https://github.com/' + OWNER + '/' + REPO + '/commit/' + c.sha;
      setMsg('commit-msg',
        '提交成功，源仓库的 workflow 会自动刷新索引并上线。 <a href="' + url +
        '" target="_blank" rel="noopener">查看提交 ↗</a>', false, true);
      pending = [];
      await loadTree();
      toast('提交完成');
    } catch (e) {
      setMsg('commit-msg', '提交失败：' + e.message, true);
      toast('提交失败：' + e.message, true);
    } finally {
      btn.disabled = false;
      renderPending();
    }
  }

  async function connect() {
    var t = $('token').value.trim();
    if (!t) return setMsg('auth-msg', '请先填写 Personal Access Token', true);
    token = t;
    setMsg('auth-msg', '正在验证…');
    try {
      var u = await gh('/user');
      $('who').innerHTML = '已连接：<b>' + esc(u.login) + '</b> ' +
        '<button class="mini" id="btn-logout">断开</button>';
      $('btn-logout').onclick = logout;
      if ($('remember').checked) {
        localStorage.setItem('jbrm_token', t);
        sessionStorage.removeItem('jbrm_token');
      } else {
        sessionStorage.setItem('jbrm_token', t);
        localStorage.removeItem('jbrm_token');
      }
      $('auth-card').hidden = true;
      $('app').hidden = false;
      setMsg('auth-msg', '');
      await loadTree();
    } catch (e) {
      token = '';
      setMsg('auth-msg', '连接失败：' + e.message, true);
    }
  }

  function logout() {
    localStorage.removeItem('jbrm_token');
    sessionStorage.removeItem('jbrm_token');
    token = '';
    items = [];
    pending = [];
    $('app').hidden = true;
    $('auth-card').hidden = false;
    $('who').textContent = '';
    $('token').value = '';
    setMsg('auth-msg', '已断开');
  }

  // ---- bindings ----
  $('btn-connect').onclick = connect;
  $('token').onkeydown = function (e) { if (e.key === 'Enter') connect(); };
  $('btn-refresh').onclick = function () {
    loadTree().catch(function (e) { toast('刷新失败：' + e.message, true); });
  };
  $('btn-clear').onclick = function () { pending = []; renderPending(); };
  $('btn-commit').onclick = commit;
  $('btn-rename').onclick = renameDir;
  $('btn-move').onclick = addMove;
  $('filter').oninput = renderTree;

  $('tree').onclick = function (e) {
    var del = e.target.getAttribute('data-del');
    var mv = e.target.getAttribute('data-move');
    if (del) addDelete(del);
    if (mv) {
      renderSelects();
      $('move-file').value = mv;
      toast('已选中 ' + basename(mv) + '，请选择目标目录');
    }
  };
  $('pending').onclick = function (e) {
    var id = e.target.getAttribute('data-undo');
    if (!id) return;
    pending = pending.filter(function (p) { return String(p.id) !== id; });
    renderPending();
  };

  $('drop').onclick = function () { $('file-input').click(); };
  $('drop').ondragover = function (e) { e.preventDefault(); $('drop').classList.add('over'); };
  $('drop').ondragleave = function () { $('drop').classList.remove('over'); };
  $('drop').ondrop = function (e) {
    e.preventDefault();
    $('drop').classList.remove('over');
    handleFiles(e.dataTransfer.files);
  };
  $('file-input').onchange = function (e) { handleFiles(e.target.files); };

  var saved = localStorage.getItem('jbrm_token') || sessionStorage.getItem('jbrm_token');
  if (saved) { $('token').value = saved; connect(); }
})();
