(function () {
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".site-nav-menu[open]").forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute("open");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".site-nav-menu[open]").forEach((d) => d.removeAttribute("open"));
  });
})();
