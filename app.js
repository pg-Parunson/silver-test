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

  /* ---------- 과목 ----------
   * 과목마다 문제은행이 따로 있고 순위표도 따로 쌓인다.
   * 'jewelry'는 첫 시험이라 순위 키에 접두어가 없다 — 기존 응시 기록을 지키기 위해서다.
   * 새 과목은 rankKey 접두어를 붙여 다른 행으로 들어간다.
   */
  var SUBJECTS = {
    jewelry: {
      key: 'jewelry', label: '주얼리 제품 관리', short: '주얼리',
      bank: 'QUESTIONS', rankKey: '',       // 접두어 없음 = 기존 기록 유지
      code: '대분류 인쇄·목재·가구·공예 · 소분류 귀금속·보석 · 능력단위 주얼리 제품 관리 (LM2202020611_16v3)',
      title: '주얼리 제품 관리<br>모의평가 문제지',
      note: 'source-note-jewelry',
      files: true,
      hidden: true      // 시험이 끝나 표지에서 내림. 문제·순위 기록은 그대로 남아 있다.
    },
    metalwork: {
      key: 'metalwork', label: '귀금속가공기능사', short: '귀금속',
      bank: 'QUESTIONS_METALWORK', rankKey: 'mw',
      code: '과정평가형 필기 · 왁스카빙 · 조립가공 · 가공안전관리 · 펜던트세공 · 기초조각 · 솔더링/버프연마 · 주얼리 제품 관리',
      title: '귀금속가공기능사<br>모의평가 문제지',
      note: 'source-note-metalwork',
      files: false
    }
  };
  // 과목 필드가 없던 옛 기록을 되돌리는 호환 열쇠. 표지에 무엇을 띄울지와는 별개다.
  var DEFAULT_SUBJECT = 'jewelry';
  function subjectOf(k) { return SUBJECTS[k] || SUBJECTS[DEFAULT_SUBJECT]; }

  function visibleSubjects() {
    return Object.keys(SUBJECTS).filter(function (k) { return !SUBJECTS[k].hidden; });
  }
  // 표지가 여는 과목 — 감춘 과목은 고를 수 없다.
  var HOME_SUBJECT = visibleSubjects()[0] || DEFAULT_SUBJECT;
  function visibleSubjectOf(k) {
    return (SUBJECTS[k] && !SUBJECTS[k].hidden) ? k : HOME_SUBJECT;
  }

  /** 지금 과목의 문제은행 (없으면 빈 배열) */
  function bankOf(subjectKey) {
    var b = window[subjectOf(subjectKey).bank];
    return Array.isArray(b) ? b : [];
  }
  /** 순위표에서 과목+유형을 구분하는 키 */
  function rankMode(subjectKey, modeKey) {
    var p = subjectOf(subjectKey).rankKey;
    return p ? p + '-' + modeOf(modeKey).key : modeOf(modeKey).key;
  }
  // 서버로 나가는 mode 값은 이 목록 안에서만 허용한다.
  // modeOf()로 걸러선 안 된다 — 'mw-full' 같은 키가 'full'로 뭉개져 과목이 섞인다.
  var RANK_MODES = (function () {
    var out = {};
    Object.keys(SUBJECTS).forEach(function (sk) {
      Object.keys(MODES).forEach(function (mk) { out[rankMode(sk, mk)] = true; });
    });
    return out;
  })();
  function normRankMode(m) { return RANK_MODES[m] ? m : DEFAULT_MODE; }
  var LS_HISTORY = 'jewelry-exam-history-v1';
  var LS_INPROGRESS = 'jewelry-exam-inprogress-v3';   // v3: 주관식 답안이 배열
  var LS_NAME = 'jewelry-exam-name-v1';
  var LS_RANKING = 'jewelry-exam-ranking-v1';
  var LS_SUBJECT = 'jewelry-exam-subject-v1';

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
      mode = normRankMode(mode);
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
      mode = normRankMode(mode);
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

  function buildExam(modeKey, subjectKey) {
    var m = modeOf(modeKey);
    var BANK = bankOf(subjectKey);
    var usedSigs = {};   // 객관식·주관식이 서명을 공유해야 "정의 문항"이 양쪽에 겹치지 않는다
    var counters = { ox: 0 };
    var mc = [];
    var sa = [];

    if (m.mc > 0) {
      var mcPool = BANK.filter(function (q) { return q.type === 'mc'; });
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
      var saPool = BANK.filter(function (q) { return q.type === 'sa'; });
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

  function startExam(saved, modeKey, subjectKey) {
    if (saved) {
      state = saved;
      if (!state.mode) state.mode = DEFAULT_MODE;         // 모드 도입 전 저장분 호환
      if (!state.subject) state.subject = DEFAULT_SUBJECT; // 과목 도입 전 저장분 호환
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
        subject: subjectOf(subjectKey).key,
        questions: buildExam(modeKey, subjectKey),
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
    // 한 글자짜리 정답("4")은 접두를 열어 두면 "40", "4번" 따위가 다 통과하므로 완전일치만 본다.
    var u = vals[0];
    return !!u && (q.accept || []).some(function (a) {
      var n = normalizeSA(a);
      if (!n.length) return false;
      return n.length < 2 ? n === u : (n === u || u.indexOf(n) === 0);
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
      subject: subjectOf(state.subject).key,
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
    var mode = rankMode(record.subject, record.mode);
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
            subjectOf(record.subject).short + ' ' + modeOf(record.mode).label +
            ' 응시자 ' + rows.length + '명 중 <b>' + (i + 1) + '위</b>' +
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
      subjectOf(record.subject).label + ' · ' +
      (m.key === 'sa' ? '주관식만 · 주관식 20문항' : '전체 시험 · 객관식 16 + 주관식 4');
    $('#ranking-note-result').textContent =
      subjectOf(record.subject).short + ' ' + m.label + ' 순위';
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
  // 직접 풀고 바로 채점받는 방식. 시간·랭킹 없음.

  var study = {
    list: [], idx: 0, unit: 'all', type: 'all', subject: DEFAULT_SUBJECT,
    mine: undefined,      // 지금 문제에 쓴 답
    checked: false,       // 채점했는가
    correct: null,        // 채점 결과
    gaveUp: false,        // 모르겠어요로 넘긴 문제
    seen: {},             // 문항별 결과 기록 (뒤로 갔다 와도 유지)
    stats: { right: 0, wrong: 0 }
  };

  function studyPool() {
    return bankOf(study.subject).filter(function (q) {
      if (study.unit !== 'all' && q.unit !== study.unit) return false;
      if (study.type !== 'all' && q.type !== study.type) return false;
      return true;
    });
  }

  function studyReload() {
    // 선지 순서를 섞어 위치를 외우지 못하게 한다
    study.list = shuffle(studyPool()).map(function (q) {
      if (q.type !== 'mc') return q;
      var order = shuffle(q.choices.map(function (_, i) { return i; }));
      return {
        id: q.id, type: 'mc', unit: q.unit, source: q.source, question: q.question,
        image: q.image || null,
        choices: order.map(function (i) { return q.choices[i]; }),
        answer: order.indexOf(q.answer),
        explanation: q.explanation
      };
    });
    study.idx = 0;
    study.seen = {};
    study.stats = { right: 0, wrong: 0 };
    loadStudySlot();
  }

  // 현재 문항의 상태를 seen에서 복원 (이전/다음으로 오갈 때)
  function loadStudySlot() {
    var rec = study.seen[study.idx];
    study.mine = rec ? rec.mine : undefined;
    study.checked = !!rec;
    study.correct = rec ? rec.correct : null;
    study.gaveUp = rec ? rec.gaveUp : false;
    renderStudy();
  }

  function studyCheck(gaveUp) {
    var q = study.list[study.idx];
    if (!q || study.checked) return;
    var correct;
    if (gaveUp) {
      correct = false;
    } else if (q.type === 'mc') {
      if (study.mine === undefined) { alert('답을 선택해 주세요.'); return; }
      correct = study.mine === q.answer;
    } else {
      if (!hasAnswer(q, study.mine)) { alert('답을 기입해 주세요.'); return; }
      correct = gradeSA(q, study.mine);
    }
    study.checked = true;
    study.correct = correct;
    study.gaveUp = !!gaveUp;
    study.seen[study.idx] = { mine: study.mine, correct: correct, gaveUp: !!gaveUp };
    if (!gaveUp) study.stats[correct ? 'right' : 'wrong']++;
    renderStudy();
  }

  function renderStudy() {
    var area = $('#study-area');
    area.innerHTML = '';
    var total = study.list.length;
    $('#study-progress').textContent = total ? (study.idx + 1) + ' / ' + total : '0 / 0';
    var st = study.stats;
    $('#study-stats').innerHTML = (st.right || st.wrong)
      ? '<span class="ok">맞음 ' + st.right + '</span> · <span class="no">틀림 ' + st.wrong + '</span>'
      : '';

    if (!total) {
      area.innerHTML = '<div class="paper qcard"><p class="qtext">조건에 맞는 문제가 없습니다.</p></div>';
      $('#btn-check').disabled = true;
      $('#btn-giveup').disabled = true;
      return;
    }

    var q = study.list[study.idx];
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
      var wrap = document.createElement('div');
      wrap.className = 'choices';
      q.choices.forEach(function (c, ci) {
        var b = document.createElement('button');
        b.type = 'button';
        var cls = 'choice';
        if (!study.checked) {
          if (study.mine === ci) cls += ' selected';
        } else {
          cls += ' static';
          if (ci === q.answer) cls += ' is-answer';
          if (ci === study.mine && ci !== q.answer) cls += ' is-wrong';
        }
        b.className = cls;
        b.innerHTML = '<span class="num">' + CIRCLED[ci] + '</span><span>' + escapeHtml(c) + '</span>' +
          (study.checked && ci === q.answer ? '<span class="ans-mark ok">정답</span>' : '') +
          (study.checked && ci === study.mine && ci !== q.answer ? '<span class="ans-mark no">내 선택</span>' : '');
        if (!study.checked) {
          b.addEventListener('click', function () {
            study.mine = (study.mine === ci) ? undefined : ci;
            renderStudy();
          });
        }
        wrap.appendChild(b);
      });
      card.appendChild(wrap);
    } else if (!study.checked) {
      card.appendChild(buildAnswerBox(q, study.mine, function (vals) { study.mine = vals; }));
    } else {
      var labels = slotLabels(q);
      var written = answerFields(q, study.mine).map(function (v, s) {
        v = (v || '').trim();
        if (!v) return null;
        return (slotCount(q) > 1 ? labels[s] + ' ' : '') + v;
      }).filter(Boolean);
      var mineRow = document.createElement('p');
      mineRow.className = 'rrow ' + (study.correct ? 'my-right' : 'my-wrong');
      mineRow.innerHTML = '<b>내 답:</b> ' + (written.length ? escapeHtml(written.join('  /  ')) : '(미기입)');
      card.appendChild(mineRow);
      var ansRow = document.createElement('p');
      ansRow.className = 'rrow study-answer';
      ansRow.innerHTML = '<b>정답:</b> ' + escapeHtml(q.answerText);
      card.appendChild(ansRow);
    }

    if (study.checked) {
      var v = document.createElement('div');
      v.className = 'study-verdict ' + (study.correct ? 'ok' : 'no');
      v.textContent = study.gaveUp ? '정답을 확인했습니다'
        : (study.correct ? '⭕ 정답입니다' : '❌ 오답입니다');
      card.insertBefore(v, card.firstChild.nextSibling);

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

    $('#btn-check').disabled = study.checked;
    $('#btn-check').textContent = study.checked ? '채점 완료' : '정답 확인';
    $('#btn-giveup').disabled = study.checked;
    $('#btn-study-prev').disabled = study.idx === 0;
    $('#btn-study-next').disabled = study.idx >= total - 1;
  }

  function startStudy() {
    var sel = $('#study-unit');
    // 단원 목록은 과목마다 다르다 — 과목이 바뀌면 다시 채우고 필터도 초기화한다.
    if (sel.getAttribute('data-subject') !== study.subject) {
      var units = [];
      bankOf(study.subject).forEach(function (q) { if (units.indexOf(q.unit) === -1) units.push(q.unit); });
      units.sort();
      sel.innerHTML = '<option value="all">전체 단원</option>' +
        units.map(function (u) { return '<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + '</option>'; }).join('');
      sel.setAttribute('data-subject', study.subject);
      sel.value = 'all';
      study.unit = 'all';
    }
    studyReload();
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
      subject: subjectOf(record.subject).key,
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

  var homeRankMode = DEFAULT_MODE;         // 홈 순위표에서 보고 있는 유형 탭
  var homeSubject = HOME_SUBJECT;          // 홈에서 고른 과목

  try {
    var savedSubject = localStorage.getItem(LS_SUBJECT);
    if (savedSubject && SUBJECTS[savedSubject] && !SUBJECTS[savedSubject].hidden) {
      homeSubject = savedSubject;
    }
  } catch (e) {}

  function renderHomeRanking() {
    var m = modeOf(homeRankMode);
    $('#ranking-note').textContent =
      (CFG ? '모든 응시자 공유 순위' : '이 기기의 응시 기록 기준') +
      ' · ' + subjectOf(homeSubject).short +
      ' · ' + (m.key === 'sa' ? '주관식 20문항' : '객관식 16 + 주관식 4') +
      ' · 재응시 시 최신 점수로 갱신';
    Array.prototype.forEach.call($('#rank-tabs').children, function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === m.key);
    });
    return renderRankingInto('ranking-body', null, rankMode(homeSubject, m.key));
  }

  // 표지·자료실·순위표를 고른 과목으로 갈아끼운다.
  function renderSubject() {
    var s = subjectOf(homeSubject);
    var n = bankOf(homeSubject).length;

    var tabs = $('#subject-tabs');
    Array.prototype.forEach.call(tabs.children, function (b) {
      var k = b.getAttribute('data-subject');
      b.classList.toggle('hidden', !!(SUBJECTS[k] && SUBJECTS[k].hidden));
      b.classList.toggle('is-on', k === s.key);
    });
    tabs.classList.toggle('hidden', visibleSubjects().length < 2);
    $('#cover-code').textContent = s.code;
    $('#cover-title').innerHTML = s.title;
    $('#hint-count').textContent = n ? n + '문항' : '전 문항';
    document.title = s.label + ' 모의평가';

    Object.keys(SUBJECTS).forEach(function (k) {
      var el = document.getElementById(SUBJECTS[k].note);
      if (el) el.classList.toggle('hidden', k !== s.key);
    });
    $('#files-section').classList.toggle('hidden', !s.files);
  }

  function renderHome() {
    try { $('#input-name').value = localStorage.getItem(LS_NAME) || ''; } catch (e) {}
    renderSubject();
    renderHomeRanking();

    var h = loadHistory().filter(function (x) {
      return subjectOf(x.subject).key === homeSubject;
    });
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
    var bank = bankOf(homeSubject);
    if (!bank.length) {
      alert(subjectOf(homeSubject).label + ' 문제은행이 아직 준비되지 않았습니다.');
      return;
    }
    var m = modeOf(modeKey);
    var pool = bank.filter(function (q) { return q.type === 'sa'; }).length;
    if (m.key === 'sa' && pool < m.sa) {
      alert('주관식 문항이 ' + pool + '개뿐이라 ' + m.sa + '문항 시험을 만들 수 없습니다.');
      return;
    }
    startExam(null, m.key, homeSubject);
  }

  $('#btn-start').addEventListener('click', function () { tryStart('full'); });
  $('#btn-start-sa').addEventListener('click', function () { tryStart('sa'); });

  $('#btn-study').addEventListener('click', function () {
    if (!bankOf(homeSubject).length) {
      alert(subjectOf(homeSubject).label + ' 문제은행이 아직 준비되지 않았습니다.');
      return;
    }
    study.subject = homeSubject;
    startStudy();
  });

  $('#subject-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.subject-tab');
    if (!b) return;
    var k = b.getAttribute('data-subject');
    if (!SUBJECTS[k] || SUBJECTS[k].hidden || k === homeSubject) return;
    homeSubject = k;
    try { localStorage.setItem(LS_SUBJECT, k); } catch (err) {}
    renderHome();
  });
  $('#btn-study-home').addEventListener('click', function () { renderHome(); show('screen-home'); });
  $('#btn-study-shuffle').addEventListener('click', function () { studyReload(); });
  $('#study-unit').addEventListener('change', function () { study.unit = this.value; studyReload(); });
  $('#study-type').addEventListener('change', function () { study.type = this.value; studyReload(); });
  $('#btn-check').addEventListener('click', function () { studyCheck(false); });
  $('#btn-giveup').addEventListener('click', function () { studyCheck(true); });
  $('#btn-study-prev').addEventListener('click', function () {
    if (study.idx > 0) { study.idx--; loadStudySlot(); }
  });
  $('#btn-study-next').addEventListener('click', function () {
    if (study.idx < study.list.length - 1) { study.idx++; loadStudySlot(); }
  });
  // 학습 중 Enter — 채점 전이면 채점, 채점 후면 다음 문제
  $('#screen-study').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!study.checked) studyCheck(false);
    else $('#btn-study-next').click();
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
    var sub = state && state.record ? subjectOf(state.record.subject).key : homeSubject;
    // 방금 본 과목이 표지에서 내려간 과목이면 표지까지만 간다.
    // 여기서 homeSubject 로 갈아타 버리면 응시자가 모르는 사이 다른 과목 시험이 시작되고,
    // 그 점수가 그 과목 순위표의 기존 행을 덮어쓴다.
    if (SUBJECTS[sub].hidden) {
      renderHome();
      show('screen-home');
      return;
    }
    homeSubject = sub;
    renderHome();
    show('screen-home');
    tryStart(again);   // 방금 본 과목·유형으로 다시
  });
  $('#btn-home').addEventListener('click', function () { renderHome(); show('screen-home'); });

  /* ---------- 초기화 ---------- */

  (function init() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_INPROGRESS)); } catch (e) {}
    if (saved && saved.deadline > Date.now() && saved.name) {
      var savedLabel = subjectOf(saved.subject).short + ' ' + modeOf(saved.mode).label;
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
