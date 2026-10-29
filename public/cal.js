/* The HTML contains usable contact options even without JavaScript or a scheduler. */
(function () {
  var mount = document.getElementById('calMount');
  if (!mount) return;
  var url;
  try { url = new URL((window.FW_CALENDLY || '').trim()); } catch (_) { return; }
  if (url.protocol !== 'https:' || url.hostname !== 'calendly.com' || !/^\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+\/?$/.test(url.pathname)) return;
  var fallback = mount.innerHTML;
  var direct = document.createElement('p');
  direct.className = 'scheduler-direct';
  var link = document.createElement('a');
  link.href = url.href; link.textContent = 'Open the booking calendar';
  link.target = '_blank'; link.rel = 'noopener'; direct.appendChild(link);
  url.searchParams.set('primary_color', '1B48C9');
  url.searchParams.set('background_color', 'FFFFFF');
  url.searchParams.set('text_color', '20251F');
  var box = document.createElement('div');
  box.className = 'calendly-inline-widget';
  box.setAttribute('data-url', url.href);
  box.setAttribute('data-resize', 'true');
  box.style.minWidth = '280px'; box.style.height = '720px';
  mount.replaceChildren(direct, box);
  var script = document.createElement('script');
  script.src = 'https://assets.calendly.com/assets/external/widget.js'; script.async = true;
  script.onerror = function () { mount.innerHTML = fallback; mount.prepend(direct); };
  document.head.appendChild(script);
  if (window.posthog) window.posthog.capture('book_call_view');
})();
