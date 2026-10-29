/* The project request form on /start. Posts to the worker at /api/lead. */
(function () {
  var form = document.getElementById('reqForm');
  if (!form) return;
  var note = document.getElementById('reqNote'), go = document.getElementById('reqGo');
  var resting = note.textContent, sending = false;

  function say(msg, kind) { note.textContent = msg; note.className = 'req-note' + (kind ? ' ' + kind : ''); }

  function field(name) { return form.querySelector('[name="' + name + '"]'); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;

    var d = new FormData(form), body = {};
    ['company', 'name', 'email', 'phone', 'product', 'website', 'need', 'notes', 'fax'].forEach(function (k) {
      body[k] = (d.get(k) || '').toString();
    });
    body.prospectToken = window.fwToken || '';
    body.page = location.pathname;

    if (!body.company.trim()) { say('Start with the business name.', 'bad'); field('company').focus(); return; }
    if (!body.email.trim() && !body.phone.trim()) {
      say('Leave an email or a phone number so there is a way back to you.', 'bad'); field('email').focus(); return;
    }

    sending = true; go.disabled = true; go.textContent = 'Sending…'; say('Sending…');

    fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'That did not go through.');
        var card = form.parentNode;
        card.innerHTML = '<div class="req-done"><span class="mono k">Request received</span>' +
          '<h2>Got it.</h2>' +
          '<p>You get a reply at the ' + (body.email.trim() ? 'address' : 'number') +
          ' you left, usually the same day. If it is urgent, call ' +
          '<a href="tel:+19727422543">+1 972-742-2543</a>.</p></div>';
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
})();
