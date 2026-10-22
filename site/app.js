// Hero console: a batch run that plays out line by line, like the real tool output.
(function () {
  var list = document.getElementById('console-lines');
  var counter = document.getElementById('console-counter');
  var names = ['client-a.co.kr', 'client-b.co.kr', 'shop-c.com', 'blog-d.kr', 'landing-e.co.kr', 'portal-f.net', 'docs-g.dev', 'catalog-h.co.kr',
    'insure-i.co.kr', 'clinic-j.kr', 'law-k.com', 'travel-l.co.kr', 'estate-m.kr', 'school-n.ac.kr', 'cafe-o.com', 'studio-p.kr'];
  var total = 106, done = 0, i = 0, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function line() {
    var li = document.createElement('li');
    var fail = (i % 23 === 7);
    li.className = fail ? 'fail' : 'ok';
    var ms = 120 + ((i * 37) % 260);
    li.innerHTML = '<i></i><span>' + names[i % names.length] + (fail ? ' · [auth] 530 Login incorrect' : ' · robots.txt · 31 B') + '</span><span class="ms">' + (fail ? '—' : ms + ' ms') + '</span>';
    list.appendChild(li);
    while (list.children.length > 11) list.removeChild(list.firstChild);
    done++; i++;
    counter.textContent = done + ' / ' + total;
    if (done >= total) { done = 0; i = 0; setTimeout(function () { list.innerHTML = ''; run(); }, 2600); return; }
    setTimeout(line, reduced ? 0 : 220 + (i % 5) * 40);
  }
  function run() { line(); }
  run();
})();
