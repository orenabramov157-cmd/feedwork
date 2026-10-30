/* Existing /api/lead contract. No lead is submitted until the visitor confirms. */
(function () {
  var form = document.getElementById('reqForm');
  if (!form) return;
  var note = document.getElementById('reqNote'), go = document.getElementById('reqGo');
  var resting = note.textContent, buttonText = go.textContent, sending = false;
  /* one id per form fill, so a retry after a lost reply is not a second request */
  var submission = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  /* the button ships disabled, so nothing can be sent as a plain page load before this script runs */
  go.disabled = false;
  function field(name) { return form.querySelector('[name="' + name + '"]'); }
  function say(message, bad) { note.textContent = message; note.className = 'req-note' + (bad ? ' bad' : ''); }
  function error(name, message) {
    field(name).setAttribute('aria-invalid', message ? 'true' : 'false');
    document.getElementById(name + '-error').textContent = message;
  }
  var params = new URLSearchParams(location.search);
  var services = {website: 'Website', creative: 'Ad creative', both: 'Creative and website'};
  var selected = services[params.get('service')];
  var style = ['quiet', 'bold', 'expressive'].includes(params.get('style')) ? params.get('style') : '';
  if (style && !selected) selected = 'Website';
  if (selected) form.querySelectorAll('[name="need"]').forEach(function (radio) { radio.checked = radio.value === selected; });
  function updateStyle() {
    var context = document.getElementById('style-context');
    var need = form.querySelector('[name="need"]:checked').value;
    var active = style && (need === 'Website' || need === 'Creative and website');
    context.hidden = !active;
    context.textContent = active ? 'Website direction: ' + style[0].toUpperCase() + style.slice(1) + '. You can change this later.' : '';
  }
  updateStyle(); form.addEventListener('change', updateStyle);
  form.addEventListener('submit', function (event) {
    event.preventDefault(); if (sending) return;
    ['company', 'email', 'phone'].forEach(function (name) { error(name, ''); });
    var data = new FormData(form), body = {};
    ['company', 'name', 'email', 'phone', 'product', 'website', 'location', 'need', 'notes', 'fax'].forEach(function (key) { body[key] = (data.get(key) || '').toString().trim(); });
    /* the visitor's own time zone, so times can be shown to them in theirs and to Oren in Pacific */
    try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { body.timezone = ''; }
    var first;
    if (!body.company) { error('company', 'Enter your business name.'); first = 'company'; }
    if (!body.email && !body.phone) {
      error('email', 'Add an email or phone number so we can reply.');
      error('phone', 'An email or phone number is required.'); first = first || 'email';
    } else if (body.email && !/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(body.email)) {
      error('email', 'Enter a valid email address.'); first = first || 'email';
    }
    if (first) { say('Please check the highlighted fields.', true); field(first).focus(); return; }
    if (style && (body.need === 'Website' || body.need === 'Creative and website')) body.need += ' / ' + style;
    body.prospectToken = window.fwToken || ''; body.page = location.pathname; body.submissionId = submission;
    sending = true; go.disabled = true; go.textContent = 'Sending…'; say('Sending your request…');
    fetch('/api/lead', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
      .then(function (response) { return response.json().then(function (result) {
        if (!response.ok || !result || result.ok !== true) throw new Error('Your request could not be sent.');
        return result;
      }); })
      .then(function () {
        var card = form.parentNode;
        card.innerHTML = '<div class="req-done"><span class="mono k">Request received</span><h2 tabindex="-1">Thank you. Let’s take it from here.</h2><p>We’ll review your brief and reply using the contact details you shared. If you need to add anything, email <a href="mailto:consult@feedworkstudio.com">consult@feedworkstudio.com</a>.</p><p><a href="/">Back to Feedwork Studio</a></p></div>';
        card.querySelector('h2').focus();
        if (window.posthog) window.posthog.capture('project_request_sent', {prospect_token: body.prospectToken || null});
      })
      .catch(function () {
        sending = false; go.disabled = false; go.textContent = buttonText;
        say('Your request could not be sent. Your details are still here; please try again, email consult@feedworkstudio.com, or call +1 972-742-2543.', true);
      });
  });
  form.addEventListener('input', function (event) {
    if (sending) return;
    if (['company', 'email', 'phone'].includes(event.target.name)) error(event.target.name, '');
    if (event.target.name === 'email' || event.target.name === 'phone') { error('email', ''); error('phone', ''); }
    if (note.classList.contains('bad')) say(resting);
  });
})();
