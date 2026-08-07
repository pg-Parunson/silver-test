/* 주얼리 제품 관리 모의시험 */
(function () {
  'use strict';

  var EXAM_MINUTES = 60;
  var MC_COUNT = 16;
  var SA_COUNT = 4;
  var POINT = 5; // 문항당 배점
  var PASS = 60; // 합격 기준(과정평가 통상 60점)
  var LS_HISTORY = 'jewelry-exam-history-v1';
  var LS_INPROGRESS = 'jewelry-exam-inprogress-v1';

  var $ = function (sel) { return document.querySelector(sel); };

  var state = null; // { questions, answers, idx, deadline, startedAt }
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

  // 단원별로 골고루 뽑기: 단원 그룹을 셔플해 라운드로빈으로 채운다
  function sampleSpread(pool, n) {
    var byUnit = {};
    pool.forEach(function (q) {
      (byUnit[q.unit] = byUnit[q.unit] || []).push(q);
    });
    var groups = shuffle(Object.keys(byUnit)).map(function (u) { return shuffle(byUnit[u]); });
    var picked = [];
    var gi = 0;
    while (picked.length < n) {
      var remaining = groups.filter(function (g) { return g.length > 0; });
      if (!remaining.length) break;
      var g = remaining[gi % remaining.length];
      picked.push(g.pop());
      gi++;
    }
    return picked;
  }

  function normalizeSA(s) {
    return (s || '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[()\[\].,·'"‘’“”~\-–—_/\\]/g, '');
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

  var CIRCLED = ['①', '②', '③', '④', '⑤'];

  function show(id) {
    ['screen-home', 'screen-exam', 'screen-result'].forEach(function (s) {
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
    window.scrollTo(0, 0);
  }

  /* ---------- 시험 생성 ---------- */

  function buildExam() {
    var mcPool = QUESTIONS.filter(function (q) { return q.type === 'mc'; });
    var saPool = QUESTIONS.filter(function (q) { return q.type === 'sa'; });
    var mc = sampleSpread(mcPool, MC_COUNT).map(function (q) {
      // 선지 순서 셔플 (answer 인덱스 재계산)
      var order = shuffle(q.choices.map(function (_, i) { return i; }));
      return {
        id: q.id, type: 'mc', unit: q.unit, source: q.source, question: q.question,
        image: q.image || null,
        choices: order.map(function (i) { return q.choices[i]; }),
        answer: order.indexOf(q.answer),
        explanation: q.explanation
      };
    });
    var sa = sampleSpread(saPool, SA_COUNT).map(function (q) {
      return {
        id: q.id, type: 'sa', unit: q.unit, source: q.source, question: q.question,
        image: q.image || null,
        accept: q.accept, answerText: q.answerText,
        explanation: q.explanation
      };
    });
    return mc.concat(sa); // 1~16 객관식, 17~20 주관식
  }

  function startExam(saved) {
    if (saved) {
      state = saved;
    } else {
      state = {
        questions: buildExam(),
        answers: {},        // idx -> 선지 index(객관식) | 입력 문자열(주관식)
        selfGrade: {},      // 주관식 자가 정답 처리: idx -> true
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
      var answered = state.answers[i] !== undefined && state.answers[i] !== '';
      buttons[i].className = (answered ? 'answered' : '') + (i === state.idx ? ' current' : '');
    });
    $('#progress').textContent = (state.idx + 1) + ' / ' + state.questions.length;
  }

  function renderQuestion() {
    var i = state.idx;
    var q = state.questions[i];
    var area = $('#question-area');
    area.innerHTML = '';

    var card = document.createElement('div');
    card.className = 'qcard';

    var meta = document.createElement('div');
    meta.className = 'qmeta';
    meta.innerHTML =
      '<span class="tag ' + q.type + '">' + (q.type === 'mc' ? '객관식' : '주관식') + '</span>' +
      '<span class="tag unit">' + q.unit + '</span>';
    card.appendChild(meta);

    var qt = document.createElement('p');
    qt.className = 'qtext';
    qt.textContent = (i + 1) + '. ' + q.question;
    card.appendChild(qt);

    if (q.image) {
      var img = document.createElement('img');
      img.className = 'qimg';
      img.src = q.image;
      img.alt = '문제 이미지';
      card.appendChild(img);
    }

    if (q.type === 'mc') {
      var wrap = document.createElement('div');
      wrap.className = 'choices';
      q.choices.forEach(function (c, ci) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'choice' + (state.answers[i] === ci ? ' selected' : '');
        b.innerHTML = '<span class="num">' + CIRCLED[ci] + '</span><span>' + c + '</span>';
        b.addEventListener('click', function () {
          state.answers[i] = (state.answers[i] === ci) ? undefined : ci;
          persistInProgress();
          renderQuestion();
        });
        wrap.appendChild(b);
      });
      card.appendChild(wrap);
    } else {
      var input = document.createElement('input');
      input.className = 'sa-input';
      input.type = 'text';
      input.placeholder = '답을 입력하세요';
      input.value = state.answers[i] || '';
      input.addEventListener('input', function () {
        state.answers[i] = input.value;
        persistInProgress();
        updateQnav();
      });
      card.appendChild(input);
    }

    area.appendChild(card);

    $('#btn-prev').disabled = i === 0;
    $('#btn-next').textContent = i === state.questions.length - 1 ? '제출하기' : '다음';
    updateQnav();
  }

  /* ---------- 채점 ---------- */

  function gradeSA(q, userInput) {
    var u = normalizeSA(userInput);
    if (!u) return false;
    return q.accept.some(function (a) { return normalizeSA(a) === u; });
  }

  function submitExam(auto) {
    if (!auto) {
      var unanswered = state.questions.filter(function (_, i) {
        return state.answers[i] === undefined || state.answers[i] === '';
      }).length;
      var msg = unanswered > 0
        ? '안 푼 문제가 ' + unanswered + '개 있습니다. 제출할까요?'
        : '제출할까요?';
      if (!confirm(msg)) return;
    }
    stopTimer();

    var results = state.questions.map(function (q, i) {
      var mine = state.answers[i];
      var correct;
      if (q.type === 'mc') {
        correct = mine === q.answer;
      } else {
        correct = gradeSA(q, mine) || !!state.selfGrade[i];
      }
      return { q: q, mine: mine, correct: correct, idx: i };
    });

    var record = {
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
  }

  function scoreOf(record) {
    var n = record.results.filter(function (r) { return r.correct; }).length;
    return n * POINT;
  }

  /* ---------- 결과 ---------- */

  function renderResult(record) {
    var score = scoreOf(record);
    var pass = score >= PASS;
    var el = $('#result-score');
    el.innerHTML = score + '<span class="unit">점 / 100점</span>';
    el.className = 'score ' + (pass ? 'pass' : 'fail');
    $('#result-date').textContent = fmtDate(record.ts) + (record.auto ? ' · 시간 종료 자동 제출' : '');
    var nCorrect = record.results.filter(function (r) { return r.correct; }).length;
    $('#result-summary').textContent =
      '20문항 중 ' + nCorrect + '개 정답 · 소요 ' + fmtTime(record.durationMs) + (pass ? ' · 합격권 🎉' : ' · 60점 미만');

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
      '<span class="tag unit">' + q.unit + '</span>';
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
        if (ci === r.mine && ci !== q.answer) li.textContent += '  ← 내 선택';
        if (ci === q.answer) li.textContent += '  ✓ 정답';
        ul.appendChild(li);
      });
      card.appendChild(ul);
      if (r.mine === undefined) {
        var no = document.createElement('p');
        no.className = 'rrow my-wrong';
        no.textContent = '선택 안 함';
        card.appendChild(no);
      }
    } else {
      var mineRow = document.createElement('p');
      mineRow.className = 'rrow ' + (r.correct ? 'my-right' : 'my-wrong');
      mineRow.innerHTML = '<b>내 답:</b> ' + (r.mine ? escapeHtml(r.mine) : '(미작성)');
      card.appendChild(mineRow);
      var ansRow = document.createElement('p');
      ansRow.className = 'rrow';
      ansRow.innerHTML = '<b>정답:</b> ' + escapeHtml(q.answerText);
      card.appendChild(ansRow);

      // 자동 채점이 오답 처리한 주관식은 자가 정답 처리 허용
      if (!r.correct && r.mine) {
        var sg = document.createElement('div');
        sg.className = 'self-grade';
        var btn = document.createElement('button');
        btn.textContent = '맞은 걸로 처리';
        btn.addEventListener('click', function () {
          r.correct = true;
          r.selfGraded = true;
          updateHistoryLatest(record);
          renderResult(record);
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

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---------- 기록 ---------- */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch (e) { return []; }
  }

  function saveHistory(record) {
    var h = loadHistory();
    h.unshift({
      ts: record.ts,
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

  function renderHome() {
    var h = loadHistory();
    var sec = $('#history-section');
    var ul = $('#history-list');
    ul.innerHTML = '';
    sec.classList.toggle('hidden', h.length === 0);
    h.slice(0, 10).forEach(function (item) {
      var li = document.createElement('li');
      var pass = item.score >= PASS;
      li.innerHTML =
        '<span class="h-score ' + (pass ? 'pass' : 'fail') + '">' + item.score + '점</span>' +
        '<span class="h-meta">' + fmtDate(item.ts) + ' · ' + fmtTime(item.durationMs) +
        (item.auto ? ' · 자동제출' : '') + '</span>';
      ul.appendChild(li);
    });
  }

  /* ---------- 이벤트 ---------- */

  $('#btn-start').addEventListener('click', function () {
    if (typeof QUESTIONS === 'undefined' || !QUESTIONS.length) {
      alert('문제은행이 아직 준비되지 않았습니다.');
      return;
    }
    startExam();
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

  $('#btn-retry').addEventListener('click', function () { startExam(); });
  $('#btn-home').addEventListener('click', function () { renderHome(); show('screen-home'); });

  /* ---------- 초기화: 진행 중이던 시험 복구 ---------- */

  (function init() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_INPROGRESS)); } catch (e) {}
    if (saved && saved.deadline > Date.now()) {
      if (confirm('진행 중이던 시험이 있습니다. 이어서 풀까요?\n(취소하면 기록 없이 폐기됩니다)')) {
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
