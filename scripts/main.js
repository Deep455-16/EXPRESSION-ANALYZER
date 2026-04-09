/**
 * main.js – Shared utilities for EmotiScan
 */

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  const msg   = document.getElementById("toastMessage");
  if (!toast || !msg) return;

  msg.textContent = message;
  toast.className = `toast toast-${type} show`;
  const icon = toast.querySelector("i");
  if (icon) {
    icon.className = type === "error"  ? "fas fa-exclamation-circle"
                   : type === "warn"   ? "fas fa-exclamation-triangle"
                   : "fas fa-check-circle";
  }
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

// ── Mobile nav ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("mobileToggle");
  const menu   = document.getElementById("navMenu");
  toggle?.addEventListener("click", () => menu?.classList.toggle("open"));

  // Highlight active nav link
  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-menu a").forEach(a => {
    if (a.getAttribute("href") === path) a.classList.add("active");
  });
});

// ── LocalStorage helpers ──────────────────────────────────────────────────────
const Storage = {
  get:    (k, def)   => { try { const v=localStorage.getItem(k); return v!=null?JSON.parse(v):def; } catch{return def;} },
  set:    (k, v)     => { try { localStorage.setItem(k, JSON.stringify(v)); } catch{} },
  remove: k          => localStorage.removeItem(k),
};
