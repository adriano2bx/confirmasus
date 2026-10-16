'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { authFetch } from '../lib/api';
import { Brand, Icon } from './ui';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
const groups = [
  {
    label: 'Operação',
    links: [
      { label: 'Visão geral', href: '/painel', icon: 'grid' },
      { label: 'Importações', href: '/importacoes', icon: 'upload' },
      { label: 'Campanhas', href: '/campanhas', icon: 'send' },
      { label: 'Convocações', href: '/convocacoes', icon: 'users' },
      { label: 'Atendimento', href: '/atendimento', icon: 'message' },
    ],
  },
  { label: 'Análise', links: [{ label: 'Relatórios', href: '/relatorios', icon: 'report' }] },
] as const;

export function AppShell({
  children,
  title,
  eyebrow,
  actions,
}: {
  children: ReactNode;
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState<{
    name: string;
    email: string;
    role: 'ADMIN' | 'OPERATOR';
  } | null>(null);
  const crumbs = pathname.split('/').filter(Boolean);

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(async (response) => {
        if (response.ok) setUser(await response.json());
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => setMenuOpen(false), [pathname]);

  async function logout() {
    await authFetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => undefined);
    sessionStorage.removeItem('confirma_user');
    router.replace('/login');
  }

  const initials = (user?.name ?? 'Administrador')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  const visibleGroups =
    user?.role === 'ADMIN'
      ? [
          ...groups,
          {
            label: 'Administração',
            links: [
              { label: 'Usuários', href: '/usuarios', icon: 'user' },
              { label: 'Auditoria', href: '/auditoria', icon: 'report' },
            ],
          },
        ]
      : groups;

  return (
    <div className="app-shell">
      <button
        className="mobile-menu-button"
        aria-label={menuOpen ? 'Fechar menu' : 'Abrir menu'}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Icon name={menuOpen ? 'close' : 'menu'} />
      </button>
      {menuOpen ? (
        <button
          className="sidebar-backdrop"
          aria-label="Fechar menu"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <Link href="/painel" className="sidebar-brand" aria-label="Confirma SUS — início">
          <Brand negative />
        </Link>
        <nav className="side-nav" aria-label="Navegação principal">
          {visibleGroups.map((group) => (
            <section className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.links.map((link) => {
                const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-label={link.label}
                    title={link.label}
                    className={`nav-item${active ? ' active' : ''}`}
                  >
                    <Icon name={link.icon} />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </section>
          ))}
        </nav>
        <div className="user-panel">
          <span className="user-avatar">{initials}</span>
          <span className="user-copy">
            <strong>{user?.name ?? 'Administrador'}</strong>
            <small>{user?.email ?? 'Acesso administrativo'}</small>
          </span>
          <button
            className="icon-button inverse"
            aria-label="Sair"
            title="Sair"
            onClick={() => void logout()}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <div>
            <div className="breadcrumb" aria-label="Navegação estrutural">
              <Link href="/painel">Confirma SUS</Link>
              {crumbs.map((crumb) => (
                <span key={crumb}>/ {humanize(crumb)}</span>
              ))}
            </div>
            {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
            <h1 className="page-title">{title}</h1>
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </header>
        <main className="workspace-content">{children}</main>
      </div>
    </div>
  );
}

export function Navigation() {
  return null;
}

function humanize(value: string) {
  if (/^[0-9a-f-]{20,}$/i.test(value)) return 'Detalhe';
  const labels: Record<string, string> = {
    painel: 'Visão geral',
    importacoes: 'Importações',
    campanhas: 'Campanhas',
    convocacoes: 'Convocações',
    relatorios: 'Relatórios',
    usuarios: 'Usuários',
    auditoria: 'Auditoria',
  };
  return labels[value] ?? value.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
