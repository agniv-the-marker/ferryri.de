/** The about modal, with a soft fade/rise entrance. */

export function initAbout() {
  const modal = document.getElementById('about')!;
  const open = document.getElementById('about-link')!;
  const close = document.getElementById('about-close')!;

  const show = () => {
    modal.hidden = false;
    // next frame so the transition actually plays
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));
  };
  const hide = () => {
    modal.classList.remove('open');
    setTimeout(() => (modal.hidden = true), 360);
  };

  open.addEventListener('click', show);
  close.addEventListener('click', hide);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hide();
  });
}
