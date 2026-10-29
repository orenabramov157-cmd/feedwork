/* Mounts the Calendly inline widget on /call.
   window.FW_CALENDLY holds the event link; empty means the booking page is not
   live yet, and the page shows the phone number rather than an empty frame. */
(function () {
  var mount = document.getElementById('calMount');
  if (!mount) return;

  var url = (window.FW_CALENDLY || '').trim();
  var ok = /^https:\/\/calendly\.com\/[A-Za-z0-9._~\-]+\/[A-Za-z0-9._~\-]+/.test(url);

  if (!ok) {
    mount.innerHTML =
      '<div class="cal-fallback">' +
      '<span class="mono k">Scheduling opens shortly</span>' +
      '<p>Until it does, the fastest way to get a time is to call. ' +
      'Most days between 9 and 5 Central, and if it rings out leave a message and you get a call back the same day.</p>' +
      '<a class="cta" href="tel:+19727422543">Call +1 972-742-2543</a>' +
      '<p class="cal-alt">Rather write it down? <a href="start.html">Send the details instead.</a></p>' +
      '</div>';
    return;
  }

  /* Calendly ignores the colour parameters on plans that do not include
     branding, so the page must look right either way. */
  var sep = url.indexOf('?') > -1 ? '&' : '?';
  var src = url + sep + 'hide_gdpr_banner=1&primary_color=1B48C9&background_color=FFFFFF&text_color=151310';

  var box = document.createElement('div');
  box.className = 'calendly-inline-widget';
  box.setAttribute('data-url', src);
  box.setAttribute('data-resize', 'true');
  box.style.minWidth = '280px';
  box.style.height = '720px';
  mount.appendChild(box);

  var s = document.createElement('script');
  s.src = 'https://assets.calendly.com/assets/external/widget.js';
  s.async = true;
  s.onerror = function () {
    mount.innerHTML = '<div class="cal-fallback"><span class="mono k">Scheduler did not load</span>' +
      '<p>Call instead and we will find a time on the spot.</p>' +
      '<a class="cta" href="tel:+19727422543">Call +1 972-742-2543</a></div>';
  };
  document.head.appendChild(s);

  if (window.posthog) posthog.capture('book_call_view');
})();
