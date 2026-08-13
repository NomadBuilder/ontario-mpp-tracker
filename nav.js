(function () {
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".site-nav-menu[open]").forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute("open");
    });
  });
})();
