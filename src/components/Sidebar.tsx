import { NavLink } from "react-router-dom";
import { FolderOpen, MessageCircle, Settings } from "lucide-react";

const items = [
  { to: "/projects", icon: FolderOpen, label: "Мои проекты" },
  { to: "/chat", icon: MessageCircle, label: "Чат" },
  { to: "/settings", icon: Settings, label: "Настройки" },
];

export default function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Основная навигация">
      {items.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `sidebar-btn${isActive ? " sidebar-btn--active" : ""}`
          }
          title={label}
          aria-label={label}
        >
          <Icon size={24} strokeWidth={1.8} />
        </NavLink>
      ))}
    </nav>
  );
}
