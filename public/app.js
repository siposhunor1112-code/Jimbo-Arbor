// Progressive enhancement only: every form also works without JavaScript.
document.querySelectorAll('select[data-autosubmit]').forEach((select) => {
  select.addEventListener('change', () => select.form.submit());
});
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});
