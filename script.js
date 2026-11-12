// AluSight — interactions
(function () {
  // smooth scroll for in-page anchors
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (id.length > 1) {
        var el = document.querySelector(id);
        if (el) {
          e.preventDefault();
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });

  // active nav link on scroll
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-links a'));
  var sections = links
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  function setActive() {
    var pos = window.scrollY + 90;
    var current = sections[0];
    sections.forEach(function (s) { if (s.offsetTop <= pos) current = s; });
    links.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + (current && current.id));
    });
  }
  window.addEventListener('scroll', setActive, { passive: true });
  setActive();

  // reveal-on-scroll animation
  var targets = document.querySelectorAll('section .sec-head, .card, .step, .gal, .stat, .member');
  targets.forEach(function (t) { t.style.opacity = '0'; t.style.transform = 'translateY(16px)'; t.style.transition = 'opacity .5s ease, transform .5s ease'; });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.style.opacity = '1'; en.target.style.transform = 'none'; io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    targets.forEach(function (t) { io.observe(t); });
  } else {
    targets.forEach(function (t) { t.style.opacity = '1'; t.style.transform = 'none'; });
  }
})();
