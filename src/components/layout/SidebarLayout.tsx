import React, { useState } from 'react';
import {
  ArrowLeftRight,
  BarChart3,
  Bot,
  Boxes,
  Building2,
  Eye,
  FileText,
  History,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Settings,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import type {
  MenuSection,
  UserCompanyMembership,
  UserProfile,
  UserRole,
} from '../../types/erp';
import { ROLE_LABELS } from '../../types/erp';
import { PWAInstallButton } from '../ui/CommonUI';

interface MenuItemConfig {
  id: MenuSection;
  label: string;
  icon: React.FC<{ className?: string }>;
}

const MENU_ITEMS: MenuItemConfig[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'ai-assistant', label: 'Assistente de IA', icon: Bot },
  { id: 'financial', label: 'Financeiro', icon: Wallet },
  { id: 'invoices', label: 'Notas Fiscais', icon: FileText },
  { id: 'reconciliation', label: 'Conciliação Bancária', icon: Landmark },
  { id: 'inventory', label: 'Estoque', icon: Boxes },
  { id: 'inventory-movements', label: 'Movimentações de Estoque', icon: ArrowLeftRight },
  { id: 'reports', label: 'Relatórios', icon: BarChart3 },
  { id: 'audit-logs', label: 'Histórico de Operações', icon: History },
  { id: 'users', label: 'Usuários e Permissões', icon: ShieldCheck },
  { id: 'settings', label: 'Configurações', icon: Settings },
];

export const SidebarLayout: React.FC<{
  activeSection: MenuSection;
  onSelectSection: (section: MenuSection) => void;
  allowedSections: MenuSection[];
  userProfile: UserProfile | null;
  userRole: UserRole;
  companyName: string;
  activeCompanyId: string;
  companies: UserCompanyMembership[];
  onSwitchCompany: (companyId: string) => void;
  onOpenNewCompany: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
}> = ({
  activeSection,
  onSelectSection,
  allowedSections,
  userProfile,
  userRole,
  companyName,
  activeCompanyId,
  companies,
  onSwitchCompany,
  onOpenNewCompany,
  onSignOut,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const activeItem = MENU_ITEMS.find((m) => m.id === activeSection) ?? MENU_ITEMS[0];
  const visibleItems = MENU_ITEMS.filter((item) => allowedSections.includes(item.id));

  const handleSelect = (id: MenuSection) => {
    onSelectSection(id);
    setMobileMenuOpen(false);
  };

  const SidebarContent = (
    <div className="flex flex-col h-full bg-[#0B1F3A] text-white">
      <div className="px-5 py-5 border-b border-white/10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <img
            src="/icon.svg"
            alt="Gestão Inteligente Empresarial"
            className="w-9 h-9 rounded-lg shrink-0"
            referrerPolicy="no-referrer"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight text-white truncate">
              Gestão Inteligente
            </p>
            <p className="text-[11px] text-blue-200/80 truncate">
              {companyName || 'Climatização e Refrigeração'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Fechar menu"
          className="lg:hidden p-1.5 text-blue-100 hover:bg-white/10 rounded-lg cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Seletor Multiempresa */}
      <div className="px-3 py-3 border-b border-white/10 bg-[#08172B]/70 space-y-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-blue-200/75 flex items-center gap-1">
            <Building2 className="w-3 h-3" />
            Empresa Ativa
          </span>
          <button
            type="button"
            onClick={onOpenNewCompany}
            title="Cadastrar nova empresa"
            className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-white cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            Nova
          </button>
        </div>
        <select
          value={activeCompanyId}
          onChange={(e) => onSwitchCompany(e.target.value)}
          aria-label="Selecionar empresa ativa"
          className="w-full px-2.5 py-2 text-xs font-medium bg-[#0E294D] text-white border border-white/15 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {companies.map((c) => (
            <option key={c.companyId} value={c.companyId} className="text-slate-900 bg-white">
              {c.companyName} ({ROLE_LABELS[c.role]})
            </option>
          ))}
        </select>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Menu Principal">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeSection;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelect(item.id)}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors text-left cursor-pointer ${
                isActive
                  ? 'bg-blue-700 text-white shadow-sm'
                  : 'text-blue-100/80 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/10 bg-[#08172B]">
        <div className="mb-3 min-w-0">
          <p className="text-xs font-semibold text-white truncate">
            {userProfile?.name ?? 'Usuário'}
          </p>
          <p className="text-[11px] text-blue-200/75 truncate">
            {ROLE_LABELS[userRole]} · {userProfile?.email}
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-blue-100 bg-white/10 hover:bg-white/15 rounded-lg transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sair da Conta
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 sticky top-0 h-screen">
        {SidebarContent}
      </aside>

      {/* Mobile / Tablet Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-72 max-w-[85vw] h-full z-10 shadow-2xl">
            {SidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Abrir menu lateral"
              className="lg:hidden p-2 -ml-2 text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="truncate">{companyName || 'Gestão Inteligente Empresarial'}</span>
                <span aria-hidden="true">/</span>
                <span className="text-blue-700 font-medium truncate">{activeItem.label}</span>
              </div>
              <h1 className="text-base sm:text-lg font-semibold text-slate-900 truncate">
                {activeItem.label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {userRole === 'CONSULTA' && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg">
                <Eye className="w-3.5 h-3.5" />
                Somente Leitura
              </span>
            )}
            <PWAInstallButton variant="topbar" />
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
};
