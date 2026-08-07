/* 주얼리 제품 관리 모의평가 */
(function () {
  'use strict';

  var EXAM_MINUTES = 60;
  var MC_COUNT = 16;
  var SA_COUNT = 4;
  var PHOTO_MC_MIN = 2;   // 시험당 사진 제시형 객관식 최소 보장
  var PHOTO_SA_MIN = 1;   // 시험당 사진 제시형 주관식 최소 보장
  var POINT = 5;
  var PASS = 60;
  var LS_HISTORY = 'jewelry-exam-history-v1';
  var LS_INPROGRESS = 'jewelry-exam-inprogress-v2';
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

  // 단원별로 골고루: 단원 그룹 셔플 후 라운드로빈
  function sampleSpread(pool, n) {
    var byUnit = {};
    pool.forEach(function (q) { (byUnit[q.unit] = byUnit[q.unit] || []).push(q); });
    var groups = shuffle(Object.keys(byUnit)).map(function (u) { return shuffle(byUnit[u]); });
    var picked = [];
    var gi = 0;
    while (picked.length < n) {
      var remaining = groups.filter(function (g) { return g.length > 0; });
      if (!remaining.length) break;
      picked.push(remaining[gi % remaining.length].pop());
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

  var CIRCLED = ['①', '②', '③', '④', '⑤'];

  function show(id) {
    ['screen-home', 'screen-exam', 'screen-result'].forEach(function (s) {
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

  function nameKey(name) {
    // 정규화 이름의 SHA-256 앞 16자 — 서버에는 마스킹된 이름만 저장
    var n = normName(name);
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode('jx:' + n)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('').slice(0, 16);
      });
    }
    var h = 5381;
    for (var i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) >>> 0;
    return Promise.resolve('f' + h.toString(16));
  }

  var Ranking = {
    // 재응시 시 점수는 최신 점수로 갱신
    submit: function (name, score, durationMs) {
      var masked = maskName(name);
      return nameKey(name).then(function (id) {
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
                  id: id, name_masked: masked, score: score,
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
          name_masked: masked, score: score,
          attempts: (prev ? prev.attempts : 0) + 1,
          duration_ms: durationMs, updated_at: new Date().toISOString()
        };
        try { localStorage.setItem(LS_RANKING, JSON.stringify(map)); } catch (e) {}
        return { id: id };
      });
    },

    fetch: function () {
      if (CFG) {
        var headers = { 'apikey': CFG.anonKey, 'Authorization': 'Bearer ' + CFG.anonKey };
        return fetch(CFG.url + '/rest/v1/rankings?select=id,name_masked,score,attempts,updated_at&order=score.desc,updated_at.asc&limit=100', { headers: headers })
          .then(function (r) {
            if (!r.ok) throw new Error('ranking fetch ' + r.status);
            return r.json();
          });
      }
      var map = {};
      try { map = JSON.parse(localStorage.getItem(LS_RANKING)) || {}; } catch (e) {}
      var rows = Object.keys(map).map(function (id) {
        var r = map[id]; r.id = id; return r;
      });
      rows.sort(function (a, b) { return b.score - a.score || (a.updated_at < b.updated_at ? -1 : 1); });
      return Promise.resolve(rows);
    }
  };

  function renderRankingInto(tbodyId, myId) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return Promise.resolve();
    return Ranking.fetch().then(function (rows) {
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">아직 응시 기록이 없습니다</td></tr>';
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
          '<td>' + (r.attempts || 1) + '회</td>';
        tbody.appendChild(tr);
      });
    }).catch(function () {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">순위를 불러오지 못했습니다</td></tr>';
    });
  }

  /* ---------- 시험 생성 (사진 문항 보장) ---------- */

  function pickWithPhotos(pool, total, photoMin) {
    var photos = shuffle(pool.filter(function (q) { return q.image; })).slice(0, photoMin);
    var pickedIds = {};
    photos.forEach(function (q) { pickedIds[q.id] = true; });
    var rest = sampleSpread(pool.filter(function (q) { return !pickedIds[q.id]; }), total - photos.length);
    return shuffle(photos.concat(rest));
  }

  function buildExam() {
    var mcPool = QUESTIONS.filter(function (q) { return q.type === 'mc'; });
    var saPool = QUESTIONS.filter(function (q) { return q.type === 'sa'; });
    var mc = pickWithPhotos(mcPool, MC_COUNT, PHOTO_MC_MIN).map(function (q) {
      var order = shuffle(q.choices.map(function (_, i) { return i; }));
      return {
        id: q.id, type: 'mc', unit: q.unit, source: q.source, question: q.question,
        image: q.image || null,
        choices: order.map(function (i) { return q.choices[i]; }),
        answer: order.indexOf(q.answer),
        explanation: q.explanation
      };
    });
    var sa = pickWithPhotos(saPool, SA_COUNT, PHOTO_SA_MIN).map(function (q) {
      return {
        id: q.id, type: 'sa', unit: q.unit, source: q.source, question: q.question,
        image: q.image || null,
        accept: q.accept || [], keywords: q.keywords || null, answerText: q.answerText,
        explanation: q.explanation
      };
    });
    return mc.concat(sa); // 1~16 객관식, 17~20 주관식
  }

  function startExam(saved) {
    if (saved) {
      state = saved;
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
        questions: buildExam(),
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
      var row = document.createElement('div');
      row.className = 'sa-answer-row';
      var mark = document.createElement('span');
      mark.className = 'sa-mark';
      mark.textContent = '답 :';
      row.appendChild(mark);
      var input = document.createElement('input');
      input.className = 'sa-input';
      input.type = 'text';
      input.placeholder = '답안을 기입하시오';
      input.value = state.answers[i] || '';
      input.addEventListener('input', function () {
        state.answers[i] = input.value;
        persistInProgress();
        updateQnav();
      });
      row.appendChild(input);
      card.appendChild(row);
    }

    area.appendChild(card);

    $('#btn-prev').disabled = i === 0;
    $('#btn-next').textContent = i === state.questions.length - 1 ? '답안 제출' : '다음 ▶';
    updateQnav();
  }

  /* ---------- 채점 ---------- */

  function gradeSA(q, userInput) {
    var u = normalizeSA(userInput);
    if (!u) return false;
    if (q.keywords && q.keywords.length) {
      return q.keywords.every(function (k) { return u.indexOf(normalizeSA(k)) !== -1; });
    }
    return (q.accept || []).some(function (a) {
      var n = normalizeSA(a);
      return n === u || (n.length >= 2 && u.indexOf(n) !== -1);
    });
  }

  function submitExam(auto) {
    if (!auto) {
      var unanswered = state.questions.filter(function (_, i) {
        return state.answers[i] === undefined || state.answers[i] === '';
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
    Ranking.submit(record.name, scoreOf(record), record.durationMs).then(function (res) {
      record.rankId = res && res.id;
      return renderRankingInto('ranking-body-result', record.rankId);
    }).then(function () {
      return Ranking.fetch();
    }).then(function (rows) {
      if (!rows || !rows.length || !record.rankId) return;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === record.rankId) {
          $('#result-rank-line').innerHTML =
            '전체 ' + rows.length + '명 중 <b>' + (i + 1) + '위</b>' +
            (i === 0 ? ' 🏆' : '');
          break;
        }
      }
    }).catch(function () {});
  }

  /* ---------- 성적 통지표 ---------- */

  function renderResult(record) {
    var score = scoreOf(record);
    var pass = score >= PASS;
    var nCorrect = record.results.filter(function (r) { return r.correct; }).length;

    $('#result-name').textContent = record.name;
    $('#result-date').textContent = fmtDate(record.ts) + (record.auto ? ' (시간 종료)' : '');
    $('#result-score-cell').textContent = score + '점 / 100점';
    var passCell = $('#result-pass-cell');
    passCell.textContent = pass ? '합 격' : '불합격';
    passCell.className = pass ? 'pass' : 'fail';
    $('#result-correct').textContent = nCorrect + ' / 20';
    $('#result-duration').textContent = fmtTime(record.durationMs);
    $('#result-rank-line').textContent = '';
    $('#result-stamp').classList.toggle('hidden', !pass);

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
      var mineRow = document.createElement('p');
      mineRow.className = 'rrow ' + (r.correct ? 'my-right' : 'my-wrong');
      mineRow.innerHTML = '<b>내 답안:</b> ' + (r.mine ? escapeHtml(r.mine) : '(미기입)');
      card.appendChild(mineRow);
      var ansRow = document.createElement('p');
      ansRow.className = 'rrow';
      ansRow.innerHTML = '<b>모범답안:</b> ' + escapeHtml(q.answerText);
      card.appendChild(ansRow);

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

  /* ---------- 내 기록 ---------- */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch (e) { return []; }
  }

  function saveHistory(record) {
    var h = loadHistory();
    h.unshift({
      ts: record.ts,
      name: record.name,
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
    try { $('#input-name').value = localStorage.getItem(LS_NAME) || ''; } catch (e) {}
    $('#ranking-note').textContent = CFG
      ? '모든 응시자 공유 순위 · 재응시 시 최신 점수로 갱신'
      : '이 기기의 응시 기록 기준 · 재응시 시 최신 점수로 갱신';
    renderRankingInto('ranking-body', null);

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
        (item.name ? ' · ' + escapeHtml(item.name) : '') + '</span>' +
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
    renderHome();
    show('screen-home');
    startExam();
  });
  $('#btn-home').addEventListener('click', function () { renderHome(); show('screen-home'); });

  /* ---------- 초기화 ---------- */

  (function init() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_INPROGRESS)); } catch (e) {}
    if (saved && saved.deadline > Date.now() && saved.name) {
      if (confirm(saved.name + '님, 진행 중이던 시험이 있습니다. 이어서 응시할까요?\n(취소하면 기록 없이 폐기됩니다)')) {
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
