import { useEffect, useState, type SVGProps } from "react";
import { NavLink } from "react-router-dom";

/* Иконки — встроенные SVG, 24x24, stroke 1.8 (внешних пакетов нет). */
type IconProps = SVGProps<SVGSVGElement>;

function baseProps(props: IconProps): IconProps {
  return {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

function FolderIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function ChatIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function GearIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MoonIcon(props: IconProps) {
  return (
    <svg {...baseProps({ width: 18, height: 18, ...props })}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function SunIcon(props: IconProps) {
  return (
    <svg {...baseProps({ width: 18, height: 18, ...props })}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

/* Подписи — из словаря ru.ts (контракт волны). До появления i18n-модуля
   строки держим здесь, без дублей в разметке. CONTRACT: src/i18n/ru.ts
   экспортирует navProjects / navChat / navSettings / settingsDarkTheme. */
const items = [
  { to: "/projects", Icon: FolderIcon, label: "Мои проекты" },
  { to: "/chat", Icon: ChatIcon, label: "Чат" },
  { to: "/settings", Icon: GearIcon, label: "Настройки" },
];

function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light"
    ? "light"
    : "dark";
}

export default function Sidebar() {
  // Тема живёт на <html data-theme="…"> (переключает экран настроек).
  const [theme, setTheme] = useState<"dark" | "light">(currentTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="sidebar" aria-label="Основная навигация">
      {items.map(({ to, Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `sidebar-btn${isActive ? " sidebar-btn--active" : ""}`
          }
          data-tip={label}
          aria-label={label}
        >
          <Icon />
        </NavLink>
      ))}
      <div className="sidebar-footer">
        <span
          className="theme-indicator"
          data-tip={theme === "light" ? "Светлая тема" : "Тёмная тема"}
          role="img"
          aria-label={theme === "light" ? "Светлая тема" : "Тёмная тема"}
        >
          {theme === "light" ? <SunIcon /> : <MoonIcon />}
        </span>
      </div>
    </nav>
  );
}
