/* The project-request form in the #start section. Posts to the worker at /api/lead.
   Lives on index.html and websites.html; both carry the same markup. */
(function () {
  var form = document.getElementById('reqForm');
  if (!form) return;
  var note = document.getElementById('reqNote'), go = document.getElementById('reqGo');
  var resting = note.textContent, sending = false;

  function say(msg, kind) { note.textContent = msg; note.className = 'req-note' + (kind ? ' ' + kind : ''); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;

    var d = new FormData(form), body = {};
    ['company', 'name', 'email', 'phone', 'product', 'website', 'notes', 'fax'].forEach(function (k) {
      body[k] = (d.get(k) || '').toString();
    });
    body.prospectToken = window.fwToken || '';
    body.page = location.pathname + location.hash;

    if (!body.company.trim()) { say('Start with the business name.', 'bad'); form.company.focus(); return; }
    if (!body.email.trim() && !body.phone.trim()) {
      say('Leave an email or a phone number so there is a way back to you.', 'bad'); form.email.focus(); return;
    }

    sending = true; go.disabled = true; go.textContent = 'Sending…'; say('Sending…');

    fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'That did not go through.');
        form.innerHTML = '<div class="req-done"><span class="mono k">Request received</span>' +
          '<p>Got it. You get a reply at the email or number you left, usually the same day. ' +
          'If it is urgent, call <a href="tel:+19727422543">+1 972-742-2543</a>.</p></div>';
        if (window.posthog) posthog.capture('project_request_sent', { prospect_token: body.prospectToken || null });
      })
      .catch(function (err) {
        sending = false; go.disabled = false; go.textContent = 'Send the request';
        say((err && err.message ? err.message : 'That did not go through.') +
          ' Email consult@feedworkstudio.com or call +1 972-742-2543.', 'bad');
      });
  });

  form.addEventListener('input', function () {
    if (!sending && note.className.indexOf('bad') > -1) say(resting);
  });
  /* a CTA that says "start a project" should land in the first field, not just
     at the bottom of the page */
  function focusFirst() {
    var el = form.querySelector('input[name="company"]');
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('a[href="#start"]'), function (a) {
    a.addEventListener('click', function (e) {
      var sec = document.getElementById('start');
      if (!sec) return;
      /* done here rather than left to the hash, which does nothing when the URL
         already ends in #start */
      e.preventDefault();
      if (location.hash !== '#start') history.replaceState(null, '', '#start');
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(focusFirst, 560);
    });
  });
  if (location.hash === '#start') setTimeout(focusFirst, 400);
})();
