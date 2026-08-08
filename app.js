/* 주얼리 제품 관리 모의평가 */
(function () {
  'use strict';

  var EXAM_MINUTES = 60;
  var OX_MAX = 3;         // 시험당 OX형 상한 (기출에서 OX는 소수)
  var POINT = 5;
  var PASS = 60;

  // 시험 유형. 두 유형 모두 20문항·100점이라 채점·도장·순위 로직을 공유한다.
  var MODES = {
    full: { key: 'full', label: '전체 시험', short: '전체',
            mc: 16, sa: 4, photoMc: 2, photoSa: 1 },
    sa:   { key: 'sa',   label: '주관식만', short: '주관식',
            mc: 0,  sa: 20, photoMc: 0, photoSa: 2 }
  };
  var DEFAULT_MODE = 'full';
  function modeOf(k) { return MODES[k] || MODES[DEFAULT_MODE]; }
  var LS_HISTORY = 'jewelry-exam-history-v1';
  var LS_INPROGRESS = 'jewelry-exam-inprogress-v3';   // v3: 주관식 답안이 배열
  var LS_NAME = 'jewelry-exam-name-v1';
  var LS_RANKING = 'jewelry-exam-ranking-v1';

  var $ = function (sel) { return document.querySelector(sel); };

  var state = null;
  var timerHandle = null;

  /* ---------- 유틸 ---------- */

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 정답 서명 — 같은 사실을 묻는 문항이 한 시험지에 함께 나오지 않도록 하는 열쇠.
  // OX형(선지 2개)은 정답이 늘 "옳다/틀리다"라 서명이 무의미하므로 제외한다.
  function answerSig(q) {
    if (q.type === 'mc') {
      if (!q.choices || q.choices.length !== 4) return null;
      return 'a:' + normalizeSA(q.choices[q.answer]);
    }
    return 'a:' + normalizeSA(q.answerText || (q.accept && q.accept[0]) || '');
  }

  function isOX(q) { return q.type === 'mc' && q.choices && q.choices.length === 2; }

  /* ---------- 복수답 주관식: 답 개수만큼 답란을 나눈다 ---------- */

  // 키워드 수 = 써야 할 답의 수
  function slotCount(q) {
    return (q.type === 'sa' && q.keywords && q.keywords.length > 1) ? q.keywords.length : 1;
  }
  // ㉠㉡ 빈칸형은 자리마다 답이 정해져 있어 순서를 지켜야 한다.
  // "N가지 쓰시오"형은 순서가 상관없다.
  function isOrderedSlots(q) { return /[㉠㉡㉢㉣]/.test(q.question || ''); }

  var SLOT_MARKS = ['㉠', '㉡', '㉢', '㉣', '㉤'];
  function slotLabels(q) {
    var n = slotCount(q);
    if (n <= 1) return [''];
    var ordered = isOrderedSlots(q);
    var out = [];
    for (var i = 0; i < n; i++) out.push(ordered ? SLOT_MARKS[i] : (i + 1) + '.');
    return out;
  }

  // 답안을 항상 배열로 다룬다(구버전 기록의 문자열도 수용)
  function answerFields(q, mine) {
    var n = slotCount(q);
    var arr = Array.isArray(mine) ? mine.slice() : (mine === undefined ? [] : [mine]);
    while (arr.length < n) arr.push('');
    return arr.slice(0, Math.max(n, arr.length));
  }

  function hasAnswer(q, mine) {
    if (q.type === 'mc') return mine !== undefined;
    return answerFields(q, mine).some(function (v) { return (v || '').trim() !== ''; });
  }

  // 단원별로 골고루: 단원 그룹 셔플 후 라운드로빈.
  // 정답이 겹치는 문항과, OX_MAX를 넘는 OX형은 뒤로 미룬다(모자라면 되돌려 채움).
  function sampleSpread(pool, n, usedSigs, counters) {
    var byUnit = {};
    pool.forEach(function (q) { (byUnit[q.unit] = byUnit[q.unit] || []).push(q); });
    var groups = shuffle(Object.keys(byUnit)).map(function (u) { return shuffle(byUnit[u]); });
    var picked = [];
    var skipped = [];
    var gi = 0;
    while (picked.length < n) {
      var remaining = groups.filter(function (g) { return g.length > 0; });
      if (!remaining.length) break;
      var q = remaining[gi % remaining.length].pop();
      gi++;
      var sig = answerSig(q);
      if (sig && usedSigs[sig]) { skipped.push(q); continue; }
      if (isOX(q) && counters.ox >= OX_MAX) { skipped.push(q); continue; }
      if (sig) usedSigs[sig] = true;
      if (isOX(q)) counters.ox++;
      picked.push(q);
    }
    while (picked.length < n && skipped.length) picked.push(skipped.pop());
    return picked;
  }

  function normalizeSA(s) {
    return (s || '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[()\[\].,·'"‘’“”~\-–—_/\\]/g, '');
  }

  function normName(s) { return (s || '').trim().replace(/\s+/g, ''); }

  function maskName(name) {
    var n = normName(name);
    if (n.length <= 1) return n + '*';
    if (n.length === 2) return n[0] + '*';
    return n[0] + new Array(n.length - 1).join('*') + n[n.length - 1];
  }

  function fmtTime(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : n; };
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 순위표용 압축 표기: 올해면 "8.7 22:42", 지난해면 "25.12.31"
  function fmtDateShort(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    var p = function (n) { return n < 10 ? '0' + n : n; };
    if (d.getFullYear() !== new Date().getFullYear()) {
      return String(d.getFullYear()).slice(2) + '.' + (d.getMonth() + 1) + '.' + d.getDate();
    }
    return (d.getMonth() + 1) + '.' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var CIRCLED = ['①', '②', '③', '④', '⑤'];

  function show(id) {
    ['screen-home', 'screen-exam', 'screen-study', 'screen-result'].forEach(function (s) {
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
    window.scrollTo(0, 0);
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* ---------- 랭킹 (Supabase 연동 / 로컬 폴백) ---------- */

  var CFG = window.RANKING_CONFIG || null;

  function nameKey(name, mode) {
    // 정규화 이름의 SHA-256 앞 16자 — 서버에는 마스킹된 이름만 저장.
    // 모드마다 다른 행이어야 하므로 seed에 모드를 섞는다.
    // 'full'은 모드 도입 이전 seed를 그대로 써서 기존 기록을 보존한다.
    var n = normName(name);
    var seed = (mode && mode !== DEFAULT_MODE) ? 'jx:' + mode + ':' + n : 'jx:' + n;
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('').slice(0, 16);
      });
    }
    var h = 5381;
    for (var i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
    return Promise.resolve('f' + h.toString(16));
  }

  var Ranking = {
    // 재응시 시 점수는 최신 점수로 갱신 (같은 이름이라도 모드가 다르면 별도 행)
    submit: function (name, score, durationMs, mode) {
      var masked = maskName(name);
      mode = modeOf(mode).key;
      return nameKey(name, mode).then(function (id) {
        if (CFG) {
          var url = CFG.url + '/rest/v1/rankings';
          var headers = {
            'apikey': CFG.anonKey,
            'Authorization': 'Bearer ' + CFG.anonKey,
            'Content-Type': 'application/json'
          };
          return fetch(url + '?id=eq.' + id + '&select=attempts', { headers: headers })
            .then(function (r) { return r.json(); })
            .then(function (rows) {
              var attempts = (rows && rows[0] ? rows[0].attempts : 0) + 1;
              return fetch(url, {
                method: 'POST',
                headers: Object.assign({ 'Prefer': 'resolution=merge-duplicates' }, headers),
                body: JSON.stringify({
                  id: id, name_masked: masked, score: score, mode: mode,
                  attempts: attempts, duration_ms: durationMs,
                  updated_at: new Date().toISOString()
                })
              });
            })
            .then(function () { return { id: id }; });
        }
        // 로컬 폴백
        var map = {};
        try { map = JSON.parse(localStorage.getItem(LS_RANKING)) || {}; } catch (e) {}
        var prev = map[id];
        map[id] = {
          name_masked: masked, score: score, mode: mode,
          attempts: (prev ? prev.attempts : 0) + 1,
          duration_ms: durationMs, updated_at: new Date().toISOString()
        };
        try { localStorage.setItem(LS_RANKING, JSON.stringify(map)); } catch (e) {}
        return { id: id };
      });
    },

    fetch: function (mode) {
      mode = modeOf(mode).key;
      if (CFG) {
        var headers = { 'apikey': CFG.anonKey, 'Authorization': 'Bearer ' + CFG.anonKey };
        return fetch(CFG.url + '/rest/v1/rankings?select=id,name_masked,score,attempts,updated_at'
          + '&mode=eq.' + mode + '&order=score.desc,updated_at.asc&limit=100', { headers: headers })
          .then(function (r) {
            if (!r.ok) throw new Error('ranking fetch ' + r.status);
            return r.json();
          });
      }
      var map = {};
      try { map = JSON.parse(localStorage.getItem(LS_RANKING)) || {}; } catch (e) {}
      var rows = Object.keys(map)
        .map(function (id) { var r = map[id]; r.id = id; return r; })
        .filter(function (r) { return (r.mode || DEFAULT_MODE) === mode; });
      rows.sort(function (a, b) { return b.score - a.score || (a.updated_at < b.updated_at ? -1 : 1); });
      return Promise.resolve(rows);
    }
  };

  function renderRankingInto(tbodyId, myId, mode) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return Promise.resolve();
    return Ranking.fetch(mode).then(function (rows) {
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">아직 응시 기록이 없습니다</td></tr>';
        return;
      }
      rows.forEach(function (r, i) {
        var tr = document.createElement('tr');
        if (i === 0) tr.className = 'r-first';
        if (myId && r.id === myId) tr.className += ' r-me';
        var pass = r.score >= PASS;
        tr.innerHTML =
          '<td>' + (i + 1) + '</td>' +
          '<td>' + escapeHtml(r.name_masked) + '</td>' +
          '<td>' + r.score + '점</td>' +
          '<td class="' + (pass ? 'pass' : 'fail') + '">' + (pass ? '합격' : '불합격') + '</td>' +
          '<td class="r-when" title="' + escapeHtml(r.updated_at ? fmtDate(r.updated_at) : '') + '">' +
            fmtDateShort(r.updated_at) + '</td>' +
          '<td>' + (r.attempts || 1) + '회</td>';
        tbody.appendChild(tr);
      });
    }).catch(function () {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">순위를 불러오지 못했습니다</td></tr>';
    });
  }

  /* ---------- 시험 생성 (사진 문항 보장) ---------- */

  function pickWithPhotos(pool, total, photoMin, usedSigs, counters) {
    // 사진 문항도 서명 검사를 거쳐야 한다. 앞서 뽑힌 문항과 정답이 같은 사진 문항은
    // 뒤로 미루고, 개수가 모자랄 때만 되돌려 채운다.
    var photoPool = shuffle(pool.filter(function (q) { return q.image; }));
    var photos = [];
    var deferred = [];
    photoPool.forEach(function (q) {
      if (photos.length >= photoMin) return;
      var sig = answerSig(q);
      if (sig && usedSigs[sig]) { deferred.push(q); return; }
      photos.push(q);
    });
    while (photos.length < photoMin && deferred.length) photos.push(deferred.pop());

    var pickedIds = {};
    photos.forEach(function (q) {
      pickedIds[q.id] = true;
      var sig = answerSig(q);
      if (sig) usedSigs[sig] = true;
    });
    var rest = sampleSpread(
      pool.filter(function (q) { return !pickedIds[q.id]; }),
      total - photos.length, usedSigs, counters);
    return shuffle(photos.concat(rest));
  }

  function buildExam(modeKey) {
    var m = modeOf(modeKey);
    var usedSigs = {};   // 객관식·주관식이 서명을 공유해야 "정의 문항"이 양쪽에 겹치지 않는다
    var counters = { ox: 0 };
    var mc = [];
    var sa = [];

    if (m.mc > 0) {
      var mcPool = QUESTIONS.filter(function (q) { return q.type === 'mc'; });
      mc = pickWithPhotos(mcPool, m.mc, m.photoMc, usedSigs, counters).map(function (q) {
        var order = shuffle(q.choices.map(function (_, i) { return i; }));
        return {
          id: q.id, type: 'mc', unit: q.unit, source: q.source, question: q.question,
          image: q.image || null,
          choices: order.map(function (i) { return q.choices[i]; }),
          answer: order.indexOf(q.answer),
          explanation: q.explanation
        };
      });
    }
    if (m.sa > 0) {
      var saPool = QUESTIONS.filter(function (q) { return q.type === 'sa'; });
      sa = pickWithPhotos(saPool, m.sa, m.photoSa, usedSigs, counters).map(function (q) {
        return {
          id: q.id, type: 'sa', unit: q.unit, source: q.source, question: q.question,
          image: q.image || null,
          accept: q.accept || [], keywords: q.keywords || null, answerText: q.answerText,
          explanation: q.explanation
        };
      });
    }
    return mc.concat(sa); // 전체 시험은 1~16 객관식 / 17~20 주관식
  }

  function startExam(saved, modeKey) {
    if (saved) {
      state = saved;
      if (!state.mode) state.mode = DEFAULT_MODE;   // 모드 도입 전 저장분 호환
    } else {
      var name = normName($('#input-name').value);
      if (!name) {
        alert('성명을 기입해 주세요.');
        $('#input-name').focus();
        return;
      }
      try { localStorage.setItem(LS_NAME, name); } catch (e) {}
      state = {
        name: name,
        mode: modeOf(modeKey).key,
        questions: buildExam(modeKey),
        answers: {},
        selfGrade: {},
        idx: 0,
        startedAt: Date.now(),
        deadline: Date.now() + EXAM_MINUTES * 60 * 1000
      };
    }
    persistInProgress();
    show('screen-exam');
    renderQnav();
    renderQuestion();
    startTimer();
  }

  function persistInProgress() {
    try { localStorage.setItem(LS_INPROGRESS, JSON.stringify(state)); } catch (e) {}
  }
  function clearInProgress() {
    try { localStorage.removeItem(LS_INPROGRESS); } catch (e) {}
  }

  /* ---------- 타이머 ---------- */

  function startTimer() {
    stopTimer();
    tick();
    timerHandle = setInterval(tick, 250);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }
  function tick() {
    var left = state.deadline - Date.now();
    var el = $('#timer');
    el.textContent = fmtTime(left);
    el.classList.toggle('warn', left <= 10 * 60 * 1000 && left > 5 * 60 * 1000);
    el.classList.toggle('danger', left <= 5 * 60 * 1000);
    if (left <= 0) {
      stopTimer();
      submitExam(true);
    }
  }

  /* ---------- 시험 렌더링 ---------- */

  function renderQnav() {
    var nav = $('#qnav');
    nav.innerHTML = '';
    state.questions.forEach(function (q, i) {
      var b = document.createElement('button');
      b.textContent = i + 1;
      b.addEventListener('click', function () { state.idx = i; renderQuestion(); });
      nav.appendChild(b);
    });
    updateQnav();
  }

  function updateQnav() {
    var buttons = $('#qnav').children;
    state.questions.forEach(function (q, i) {
      var answered = hasAnswer(q, state.answers[i]);
      buttons[i].className = (answered ? 'answered' : '') + (i === state.idx ? ' current' : '');
    });
    $('#progress').textContent = (state.idx + 1) + ' / ' + state.questions.length;
  }

  // 주관식 답란. 복수답이면 답 개수만큼 칸을 만든다.
  function buildAnswerBox(q, current, onChange) {
    var n = slotCount(q);
    var labels = slotLabels(q);
    var vals = answerFields(q, current);

    var box = document.createElement('div');
    box.className = 'sa-answers' + (n > 1 ? ' multi' : '');

    if (n > 1) {
      var guide = document.createElement('p');
      guide.className = 'sa-guide';
      guide.textContent = isOrderedSlots(q)
        ? '빈칸 순서에 맞게 각 칸에 하나씩 쓰시오.'
        : n + '가지를 각 칸에 하나씩 나누어 쓰시오. (순서 무관)';
      box.appendChild(guide);
    }

    for (var s = 0; s < n; s++) {
      (function (s) {
        var row = document.createElement('div');
        row.className = 'sa-answer-row';
        var mark = document.createElement('span');
        mark.className = 'sa-mark';
        mark.textContent = n > 1 ? labels[s] : '답 :';
        row.appendChild(mark);
        var input = document.createElement('input');
        input.className = 'sa-input';
        input.type = 'text';
        input.placeholder = n > 1 ? '' : '답안을 기입하시오';
        input.value = vals[s] || '';
        input.addEventListener('input', function () {
          vals[s] = input.value;
          onChange(vals.slice());
        });
        row.appendChild(input);
        box.appendChild(row);
      })(s);
    }
    return box;
  }

  function renderQuestion() {
    var i = state.idx;
    var q = state.questions[i];
    var area = $('#question-area');
    area.innerHTML = '';

    var card = document.createElement('div');
    card.className = 'paper qcard';

    var meta = document.createElement('div');
    meta.className = 'qmeta';
    meta.innerHTML =
      '<span class="tag ' + q.type + '">' + (q.type === 'mc' ? '객관식' : '주관식') + '</span>' +
      '<span class="tag unit">' + escapeHtml(q.unit) + '</span>';
    card.appendChild(meta);

    var qt = document.createElement('p');
    qt.className = 'qtext';
    qt.textContent = (i + 1) + '. ' + q.question + ' ';
    var pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = '(' + POINT + '점)';
    qt.appendChild(pts);
    card.appendChild(qt);

    if (q.image) {
      var img = document.createElement('img');
      img.className = 'qimg';
      img.src = q.image;
      img.alt = '문제 제시 사진';
      card.appendChild(img);
    }

    if (q.type === 'mc') {
      var wrap = document.createElement('div');
      wrap.className = 'choices';
      q.choices.forEach(function (c, ci) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'choice' + (state.answers[i] === ci ? ' selected' : '');
        b.innerHTML = '<span class="num">' + CIRCLED[ci] + '</span><span>' + escapeHtml(c) + '</span>';
        b.addEventListener('click', function () {
          state.answers[i] = (state.answers[i] === ci) ? undefined : ci;
          persistInProgress();
          renderQuestion();
        });
        wrap.appendChild(b);
      });
      card.appendChild(wrap);
    } else {
      card.appendChild(buildAnswerBox(q, state.answers[i], function (vals) {
        state.answers[i] = vals;
        persistInProgress();
        updateQnav();
      }));
    }

    area.appendChild(card);

    $('#btn-prev').disabled = i === 0;
    $('#btn-next').textContent = i === state.questions.length - 1 ? '답안 제출' : '다음 ▶';
    updateQnav();
  }

  /* ---------- 채점 ---------- */

  function gradeSA(q, userInput) {
    var vals = answerFields(q, userInput).map(normalizeSA);
    if (!vals.some(function (v) { return v; })) return false;

    if (q.keywords && q.keywords.length) {
      var ks = q.keywords.map(normalizeSA);

      // 답란이 나뉜 경우 — 칸 단위로 채점.
      // (배열이 아닌 예전 형식은 아래 '몰아쓰기' 경로로 넘긴다)
      if (slotCount(q) > 1 && Array.isArray(userInput)) {
        if (isOrderedSlots(q)) {
          // ㉠㉡ 빈칸: 자리마다 정해진 답이 들어가야 한다
          return ks.every(function (k, i) {
            return !!vals[i] && vals[i].indexOf(k) !== -1;
          });
        }
        // 순서 무관: 키워드마다 서로 다른 칸이 하나씩 대응돼야 한다.
        // 긴 키워드부터 짝지어야 '강성'이 '반강성포장' 칸을 가로채지 않는다.
        var used = {};
        return ks.slice()
          .sort(function (a, b) { return b.length - a.length; })
          .every(function (k) {
            for (var i = 0; i < vals.length; i++) {
              if (!used[i] && vals[i] && vals[i].indexOf(k) !== -1) { used[i] = true; return true; }
            }
            return false;
          });
      }

      // 한 칸에 몰아 쓴 경우: 맞은 자리를 지워 가며 센다
      var rest = vals.join(' ');
      return ks.slice()
        .sort(function (a, b) { return b.length - a.length; })
        .every(function (k) {
          if (!k) return true;
          var at = rest.indexOf(k);
          if (at === -1) return false;
          rest = rest.slice(0, at) + ' ' + rest.slice(at + k.length);
          return true;
        });
    }

    // 단답: 완전일치 또는 정답으로 시작하는 경우만 인정("코멕스(COMEX)", "루페입니다" 통과).
    // 중간 포함까지 허용하면 정답 "강성"이 오답 "반강성포장"을 통과시키므로 접두 일치까지만 둔다.
    var u = vals[0];
    return !!u && (q.accept || []).some(function (a) {
      var n = normalizeSA(a);
      return n.length > 0 && (n === u || u.indexOf(n) === 0);
    });
  }

  function submitExam(auto) {
    if (!auto) {
      var unanswered = state.questions.filter(function (q, i) {
        return !hasAnswer(q, state.answers[i]);
      }).length;
      var msg = unanswered > 0
        ? '기입하지 않은 문항이 ' + unanswered + '개 있습니다. 답안을 제출할까요?'
        : '답안을 제출할까요?';
      if (!confirm(msg)) return;
    }
    stopTimer();

    var results = state.questions.map(function (q, i) {
      var mine = state.answers[i];
      var correct;
      if (q.type === 'mc') correct = mine === q.answer;
      else correct = gradeSA(q, mine) || !!state.selfGrade[i];
      return { q: q, mine: mine, correct: correct, idx: i };
    });

    var record = {
      name: state.name,
      mode: modeOf(state.mode).key,
      ts: Date.now(),
      durationMs: Math.min(Date.now() - state.startedAt, EXAM_MINUTES * 60 * 1000),
      auto: !!auto,
      results: results
    };
    state.record = record;
    clearInProgress();
    saveHistory(record);
    renderResult(record);
    show('screen-result');
    pushRanking(record);
  }

  function scoreOf(record) {
    return record.results.filter(function (r) { return r.correct; }).length * POINT;
  }

  function pushRanking(record) {
    var mode = modeOf(record.mode).key;
    Ranking.submit(record.name, scoreOf(record), record.durationMs, mode).then(function (res) {
      record.rankId = res && res.id;
      return renderRankingInto('ranking-body-result', record.rankId, mode);
    }).then(function () {
      return Ranking.fetch(mode);
    }).then(function (rows) {
      if (!rows || !rows.length || !record.rankId) return;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === record.rankId) {
          $('#result-rank-line').innerHTML =
            modeOf(mode).label + ' 응시자 ' + rows.length + '명 중 <b>' + (i + 1) + '위</b>' +
            (i === 0 ? ' 🏆' : '');
          break;
        }
      }
    }).catch(function () {});
  }

  /* ---------- 성적 통지표 ---------- */

  // 점수 구간별 선생님 도장
  function verdictOf(score) {
    if (score === 100) return { file: 'stamp-perfect.png', message: '완벽해요' };
    if (score >= 90) return { file: 'stamp-great.png', message: '참 잘했어요' };
    return { file: 'stamp-cheer.png', message: '화이팅!' };
  }

  function renderResult(record) {
    var score = scoreOf(record);
    var pass = score >= PASS;
    var nCorrect = record.results.filter(function (r) { return r.correct; }).length;
    var m = modeOf(record.mode);

    $('#result-mode').textContent =
      m.key === 'sa' ? '주관식만 · 주관식 20문항' : '전체 시험 · 객관식 16 + 주관식 4';
    $('#ranking-note-result').textContent = m.label + ' 순위';
    $('#result-name').textContent = record.name;
    $('#result-date').textContent = fmtDate(record.ts) + (record.auto ? ' (시간 종료)' : '');
    $('#result-score-cell').innerHTML = score + '<span class="of">/100</span>';
    var passCell = $('#result-pass-cell');
    passCell.textContent = pass ? '합 격' : '불합격';
    passCell.className = pass ? 'pass' : 'fail';
    $('#result-correct').textContent = nCorrect + ' / 20';
    $('#result-duration').textContent = fmtTime(record.durationMs);
    $('#result-rank-line').textContent = '';

    var v = verdictOf(score);
    var stamp = $('#result-stamp');
    stamp.src = 'images/' + v.file;
    stamp.alt = v.message + ' 도장';
    $('#result-message').textContent = v.message;

    var list = $('#result-list');
    list.innerHTML = '';
    record.results.forEach(function (r) {
      list.appendChild(renderResultCard(r, record));
    });
  }

  function renderResultCard(r, record) {
    var q = r.q;
    var card = document.createElement('div');
    card.className = 'rcard ' + (r.correct ? 'correct' : 'wrong');

    var head = document.createElement('div');
    head.className = 'rhead';
    head.innerHTML =
      '<span class="rnum">' + (r.idx + 1) + '번</span>' +
      '<span class="badge ' + (r.correct ? 'ok' : 'no') + '">' + (r.correct ? '정답' : '오답') + '</span>' +
      '<span class="tag ' + q.type + '">' + (q.type === 'mc' ? '객관식' : '주관식') + '</span>' +
      '<span class="tag unit">' + escapeHtml(q.unit) + '</span>';
    card.appendChild(head);

    var qt = document.createElement('p');
    qt.className = 'qtext';
    qt.textContent = q.question;
    card.appendChild(qt);

    if (q.image) {
      var img = document.createElement('img');
      img.className = 'qimg';
      img.src = q.image;
      card.appendChild(img);
    }

    if (q.type === 'mc') {
      var ul = document.createElement('ul');
      ul.className = 'rchoices';
      q.choices.forEach(function (c, ci) {
        var li = document.createElement('li');
        li.textContent = CIRCLED[ci] + ' ' + c;
        if (ci === q.answer) li.classList.add('answer');
        if (ci === r.mine) li.classList.add('mine');
        if (ci === r.mine && ci !== q.answer) li.textContent += '  ← 내 표기';
        if (ci === q.answer) li.textContent += '  ✓ 정답';
        ul.appendChild(li);
      });
      card.appendChild(ul);
      if (r.mine === undefined) {
        var no = document.createElement('p');
        no.className = 'rrow my-wrong';
        no.textContent = '표기 안 함';
        card.appendChild(no);
      }
    } else {
      var labels = slotLabels(q);
      var mineVals = answerFields(q, r.mine);
      var written = mineVals.map(function (v, s) {
        v = (v || '').trim();
        if (!v) return null;
        return (slotCount(q) > 1 ? labels[s] + ' ' : '') + v;
      }).filter(Boolean);

      var mineRow = document.createElement('p');
      mineRow.className = 'rrow ' + (r.correct ? 'my-right' : 'my-wrong');
      mineRow.innerHTML = '<b>내 답안:</b> ' +
        (written.length ? escapeHtml(written.join('  /  ')) : '(미기입)');
      card.appendChild(mineRow);
      var ansRow = document.createElement('p');
      ansRow.className = 'rrow';
      ansRow.innerHTML = '<b>모범답안:</b> ' + escapeHtml(q.answerText);
      card.appendChild(ansRow);

      if (!r.correct && written.length) {
        var sg = document.createElement('div');
        sg.className = 'self-grade';
        var btn = document.createElement('button');
        btn.textContent = '맞은 걸로 처리';
        btn.addEventListener('click', function () {
          r.correct = true;
          r.selfGraded = true;
          updateHistoryLatest(record);
          renderResult(record);
          pushRanking(record); // 갱신 점수 재제출
        });
        sg.appendChild(btn);
        var note = document.createElement('span');
        note.textContent = '표현만 다르고 맞게 썼다면';
        sg.appendChild(note);
        card.appendChild(sg);
      }
    }

    var ex = document.createElement('div');
    ex.className = 'expl';
    ex.textContent = q.explanation;
    if (q.source) {
      var src = document.createElement('span');
      src.className = 'src';
      src.textContent = '출처: ' + q.source;
      ex.appendChild(src);
    }
    card.appendChild(ex);

    return card;
  }

  /* ---------- 학습 모드 ---------- */

  var study = { list: [], idx: 0, hint: false, reveal: false, unit: 'all', type: 'all' };

  function studyPool() {
    return QUESTIONS.filter(function (q) {
      if (study.unit !== 'all' && q.unit !== study.unit) return false;
      if (study.type !== 'all' && q.type !== study.type) return false;
      return true;
    });
  }

  function studyReload(keepIdx) {
    study.list = shuffle(studyPool());
    study.idx = keepIdx ? Math.min(study.idx, Math.max(0, study.list.length - 1)) : 0;
    study.hint = false;
    study.reveal = false;
    renderStudy();
  }

  // 힌트는 답을 바로 주지 않는다. 객관식은 오답 2개를 지우고,
  // 주관식은 출처와 글자 수·첫 글자만 알려준다.
  function hintFor(q) {
    if (q.type === 'mc') {
      return '오답 ' + (q.choices.length === 2 ? 0 : 2) + '개를 지웠습니다. 남은 선지에서 고르세요.';
    }
    var labels = slotLabels(q);
    var parts = (q.answerText || '').split(/\s*,\s*/);
    var shape = [];
    for (var s = 0; s < slotCount(q); s++) {
      var raw = (parts[s] || '').replace(/^[㉠㉡㉢㉣]\s*/, '').trim();
      var head = raw.slice(0, 1);
      shape.push((slotCount(q) > 1 ? labels[s] + ' ' : '') +
        (head ? head + '○'.repeat(Math.max(0, raw.length - 1)) : '?') +
        ' (' + raw.length + '글자)');
    }
    return shape.join('   ');
  }

  // 객관식 힌트: 정답 외 선지 중 2개를 지운다(문항마다 같은 것이 지워지도록 고정)
  function hiddenChoices(q) {
    if (q.type !== 'mc' || q.choices.length !== 4) return {};
    var wrong = [];
    for (var i = 0; i < q.choices.length; i++) if (i !== q.answer) wrong.push(i);
    var seed = 0;
    for (var c = 0; c < q.id.length; c++) seed = (seed * 31 + q.id.charCodeAt(c)) >>> 0;
    var out = {};
    out[wrong[seed % wrong.length]] = true;
    out[wrong[(seed + 1) % wrong.length]] = true;
    return out;
  }

  function renderStudy() {
    var area = $('#study-area');
    area.innerHTML = '';
    if (!study.list.length) {
      area.innerHTML = '<div class="paper qcard"><p class="qtext">조건에 맞는 문제가 없습니다.</p></div>';
      $('#study-progress').textContent = '0 / 0';
      return;
    }
    var q = study.list[study.idx];
    $('#study-progress').textContent = (study.idx + 1) + ' / ' + study.list.length;

    var card = document.createElement('div');
    card.className = 'paper qcard';

    var meta = document.createElement('div');
    meta.className = 'qmeta';
    meta.innerHTML =
      '<span class="tag ' + q.type + '">' + (q.type === 'mc' ? '객관식' : '주관식') + '</span>' +
      '<span class="tag unit">' + escapeHtml(q.unit) + '</span>' +
      (q.source ? '<span class="tag unit">' + escapeHtml(q.source) + '</span>' : '');
    card.appendChild(meta);

    var qt = document.createElement('p');
    qt.className = 'qtext';
    qt.textContent = q.question;
    card.appendChild(qt);

    if (q.image) {
      var img = document.createElement('img');
      img.className = 'qimg';
      img.src = q.image;
      img.alt = '문제 제시 사진';
      card.appendChild(img);
    }

    if (q.type === 'mc') {
      var hidden = study.hint && !study.reveal ? hiddenChoices(q) : {};
      var wrap = document.createElement('div');
      wrap.className = 'choices';
      q.choices.forEach(function (c, ci) {
        var b = document.createElement('div');
        b.className = 'choice static' +
          (hidden[ci] ? ' struck' : '') +
          (study.reveal && ci === q.answer ? ' is-answer' : '');
        b.innerHTML = '<span class="num">' + CIRCLED[ci] + '</span><span>' + escapeHtml(c) + '</span>' +
          (study.reveal && ci === q.answer ? '<span class="ans-mark">정답</span>' : '');
        wrap.appendChild(b);
      });
      card.appendChild(wrap);
    } else if (study.reveal) {
      var ans = document.createElement('p');
      ans.className = 'rrow my-right study-answer';
      ans.innerHTML = '<b>정답:</b> ' + escapeHtml(q.answerText);
      card.appendChild(ans);
    }

    if (study.hint && !study.reveal) {
      var h = document.createElement('div');
      h.className = 'study-hint';
      h.innerHTML = '<b>힌트</b> ' + escapeHtml(hintFor(q)) +
        (q.source ? '<span class="src">' + escapeHtml(q.source) + '</span>' : '');
      card.appendChild(h);
    }

    if (study.reveal) {
      var ex = document.createElement('div');
      ex.className = 'expl';
      ex.textContent = q.explanation;
      if (q.source) {
        var src = document.createElement('span');
        src.className = 'src';
        src.textContent = '출처: ' + q.source;
        ex.appendChild(src);
      }
      card.appendChild(ex);
    }

    area.appendChild(card);

    $('#btn-hint').disabled = study.reveal;
    $('#btn-hint').textContent = study.hint ? '💡 힌트 표시 중' : '💡 힌트 보기';
    $('#btn-reveal').textContent = study.reveal ? '정답 숨기기' : '정답·해설 보기';
    $('#btn-study-prev').disabled = study.idx === 0;
    $('#btn-study-next').disabled = study.idx >= study.list.length - 1;
  }

  function startStudy() {
    var sel = $('#study-unit');
    if (!sel.options.length) {
      var units = [];
      QUESTIONS.forEach(function (q) { if (units.indexOf(q.unit) === -1) units.push(q.unit); });
      units.sort();
      sel.innerHTML = '<option value="all">전체 단원</option>' +
        units.map(function (u) { return '<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + '</option>'; }).join('');
    }
    studyReload(false);
    show('screen-study');
  }

  /* ---------- 내 기록 ---------- */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch (e) { return []; }
  }

  function saveHistory(record) {
    var h = loadHistory();
    h.unshift({
      ts: record.ts,
      name: record.name,
      mode: modeOf(record.mode).key,
      score: scoreOf(record),
      durationMs: record.durationMs,
      auto: record.auto,
      wrongIds: record.results.filter(function (r) { return !r.correct; }).map(function (r) { return r.q.id; })
    });
    if (h.length > 50) h.length = 50;
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(h)); } catch (e) {}
  }

  function updateHistoryLatest(record) {
    var h = loadHistory();
    var item = h.find(function (x) { return x.ts === record.ts; });
    if (item) {
      item.score = scoreOf(record);
      item.wrongIds = record.results.filter(function (r) { return !r.correct; }).map(function (r) { return r.q.id; });
      try { localStorage.setItem(LS_HISTORY, JSON.stringify(h)); } catch (e) {}
    }
  }

  var homeRankMode = DEFAULT_MODE;   // 홈 순위표에서 보고 있는 탭

  function renderHomeRanking() {
    var m = modeOf(homeRankMode);
    $('#ranking-note').textContent =
      (CFG ? '모든 응시자 공유 순위' : '이 기기의 응시 기록 기준') +
      ' · ' + (m.key === 'sa' ? '주관식 20문항' : '객관식 16 + 주관식 4') +
      ' · 재응시 시 최신 점수로 갱신';
    Array.prototype.forEach.call($('#rank-tabs').children, function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === m.key);
    });
    return renderRankingInto('ranking-body', null, m.key);
  }

  function renderHome() {
    try { $('#input-name').value = localStorage.getItem(LS_NAME) || ''; } catch (e) {}
    renderHomeRanking();

    var h = loadHistory();
    var sec = $('#history-section');
    var ul = $('#history-list');
    ul.innerHTML = '';
    sec.classList.toggle('hidden', h.length === 0);
    h.slice(0, 10).forEach(function (item) {
      var li = document.createElement('li');
      var pass = item.score >= PASS;
      li.innerHTML =
        '<span class="h-score ' + (pass ? 'pass' : 'fail') + '">' + item.score + '점' +
        '<span class="h-mode">' + modeOf(item.mode).short + '</span></span>' +
        '<span class="h-meta">' + fmtDate(item.ts) + ' · ' + fmtTime(item.durationMs) +
        (item.auto ? ' · 자동제출' : '') + '</span>';
      ul.appendChild(li);
    });
  }

  /* ---------- 이벤트 ---------- */

  function tryStart(modeKey) {
    if (typeof QUESTIONS === 'undefined' || !QUESTIONS.length) {
      alert('문제은행이 아직 준비되지 않았습니다.');
      return;
    }
    var m = modeOf(modeKey);
    var pool = QUESTIONS.filter(function (q) { return q.type === 'sa'; }).length;
    if (m.key === 'sa' && pool < m.sa) {
      alert('주관식 문항이 ' + pool + '개뿐이라 ' + m.sa + '문항 시험을 만들 수 없습니다.');
      return;
    }
    startExam(null, m.key);
  }

  $('#btn-start').addEventListener('click', function () { tryStart('full'); });
  $('#btn-start-sa').addEventListener('click', function () { tryStart('sa'); });

  $('#btn-study').addEventListener('click', function () {
    if (typeof QUESTIONS === 'undefined' || !QUESTIONS.length) {
      alert('문제은행이 아직 준비되지 않았습니다.');
      return;
    }
    startStudy();
  });
  $('#btn-study-home').addEventListener('click', function () { renderHome(); show('screen-home'); });
  $('#btn-study-shuffle').addEventListener('click', function () { studyReload(false); });
  $('#study-unit').addEventListener('change', function () { study.unit = this.value; studyReload(false); });
  $('#study-type').addEventListener('change', function () { study.type = this.value; studyReload(false); });
  $('#btn-hint').addEventListener('click', function () { study.hint = !study.hint; renderStudy(); });
  $('#btn-reveal').addEventListener('click', function () {
    study.reveal = !study.reveal;
    if (study.reveal) study.hint = false;
    renderStudy();
  });
  $('#btn-study-prev').addEventListener('click', function () {
    if (study.idx > 0) { study.idx--; study.hint = false; study.reveal = false; renderStudy(); }
  });
  $('#btn-study-next').addEventListener('click', function () {
    if (study.idx < study.list.length - 1) { study.idx++; study.hint = false; study.reveal = false; renderStudy(); }
  });

  $('#rank-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.rank-tab');
    if (!b) return;
    homeRankMode = b.getAttribute('data-mode');
    renderHomeRanking();
  });

  $('#input-name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#btn-start').click();
  });

  $('#btn-prev').addEventListener('click', function () {
    if (state.idx > 0) { state.idx--; renderQuestion(); }
  });

  $('#btn-next').addEventListener('click', function () {
    if (state.idx < state.questions.length - 1) {
      state.idx++;
      renderQuestion();
    } else {
      submitExam(false);
    }
  });

  $('#btn-submit-top').addEventListener('click', function () { submitExam(false); });
  $('#btn-retry').addEventListener('click', function () {
    var again = state && state.record ? modeOf(state.record.mode).key : DEFAULT_MODE;
    renderHome();
    show('screen-home');
    tryStart(again);   // 방금 본 유형으로 다시
  });
  $('#btn-home').addEventListener('click', function () { renderHome(); show('screen-home'); });

  /* ---------- 초기화 ---------- */

  (function init() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_INPROGRESS)); } catch (e) {}
    if (saved && saved.deadline > Date.now() && saved.name) {
      var savedLabel = modeOf(saved.mode).label;
      if (confirm(saved.name + '님, 진행 중이던 ' + savedLabel + '이 있습니다. 이어서 응시할까요?\n(취소하면 기록 없이 폐기됩니다)')) {
        startExam(saved);
        return;
      }
      clearInProgress();
    } else if (saved) {
      clearInProgress();
    }
    renderHome();
    show('screen-home');
  })();
})();
