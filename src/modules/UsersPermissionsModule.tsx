import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { Edit3, MailPlus, Search, ShieldCheck, UserPlus, XCircle } from 'lucide-react';
import {
  ALL_MENU_SECTIONS,
  FIELD_LIMITS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type CompanyInvite,
  type CompanyMember,
  type MenuSection,
  type UserRole,
} from '../types/erp';
import {
  cancelCompanyInvite,
  inviteCompanyMember,
  updateCompanyMemberPermissions,
} from '../services/erpService';
import { EmptyState, Modal, SkeletonTable } from '../components/ui/CommonUI';

interface UsersPermissionsModuleProps {
  currentUser: User;
  companyId: string;
  companyName: string;
  currentUserRole: UserRole;
  loading: boolean;
  members: CompanyMember[];
  invites: CompanyInvite[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

export const UsersPermissionsModule: React.FC<UsersPermissionsModuleProps> = ({
  currentUser,
  companyId,
  companyName,
  currentUserRole,
  loading,
  members,
  invites,
  onNotify,
}) => {
  const isAdmin = currentUserRole === 'ADMINISTRADOR';
  const [search, setSearch] = useState('');
  const [editingMember, setEditingMember] = useState<CompanyMember | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);

  const [form, setForm] = useState({
    name: '',
    email: '',
    role: 'CONSULTA' as UserRole,
    department: '',
    active: true,
    permissions: [] as MenuSection[],
  });

  const [inviteForm, setInviteForm] = useState({
    name: '',
    email: '',
    department: '',
    role: 'ESTOQUE' as UserRole,
  });

  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((p) => {
      if (!q) return true;
      return `${p.name} ${p.email} ${p.department ?? ''} ${ROLE_LABELS[p.role]}`.toLowerCase().includes(q);
    });
  }, [members, search]);

  const openEdit = (member: CompanyMember) => {
    setEditingMember(member);
    setForm({
      name: member.name,
      email: member.email,
      role: member.role,
      department: member.department ?? '',
      active: member.active,
      permissions:
        member.permissions && member.permissions.length > 0
          ? member.permissions
          : ROLE_DEFAULT_PERMISSIONS[member.role],
    });
  };

  const togglePermission = (sectionId: MenuSection) => {
    setForm((prev) => {
      const exists = prev.permissions.includes(sectionId);
      return {
        ...prev,
        permissions: exists
          ? prev.permissions.filter((id) => id !== sectionId)
          : [...prev.permissions, sectionId],
      };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMember || !isAdmin || saving) return;
    if (!form.name.trim()) {
      onNotify('error', 'Informe o nome do usuário.');
      return;
    }

    setSaving(true);
    try {
      await updateCompanyMemberPermissions(currentUser, companyId, companyName, editingMember.uid, {
        name: form.name,
        email: form.email,
        role: form.role,
        department: form.department,
        active: form.active,
        permissions: form.permissions,
      });
      onNotify('success', `Permissões de ${form.name} atualizadas com segurança.`);
      setEditingMember(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao atualizar permissões.');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || saving) return;
    if (!inviteForm.name.trim() || !inviteForm.email.trim()) {
      onNotify('error', 'Informe o nome e o e-mail corporativo do usuário.');
      return;
    }

    setSaving(true);
    try {
      await inviteCompanyMember(currentUser, companyId, companyName, inviteForm);
      onNotify(
        'success',
        `Convite registrado para ${inviteForm.email}. Quando ele acessar o sistema com este e-mail verificado, poderá aceitar o acesso na empresa.`
      );
      setInviteModalOpen(false);
      setInviteForm({ name: '', email: '', department: '', role: 'ESTOQUE' });
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao enviar convite.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelInvite = async (inv: CompanyInvite) => {
    if (!isAdmin) return;
    try {
      await cancelCompanyInvite(currentUser, companyId, inv.id, inv.email);
      onNotify('info', `Convite de ${inv.email} cancelado.`);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao cancelar convite.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Matriz de Perfis */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {(Object.keys(ROLE_LABELS) as UserRole[]).map((roleKey) => (
          <div key={roleKey} className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-[#0B1F3A]">{roleKey}</p>
            <p className="text-[11px] font-medium text-blue-700 mt-0.5">{ROLE_LABELS[roleKey]}</p>
            <p className="text-xs text-slate-600 mt-2 leading-relaxed">{ROLE_DESCRIPTIONS[roleKey]}</p>
          </div>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar usuário por nome, e-mail ou perfil..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        {isAdmin ? (
          <button
            type="button"
            onClick={() => setInviteModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            Convidar Usuário para Empresa
          </button>
        ) : (
          <p className="text-xs text-slate-500">Visualizando seu perfil de acesso atual nesta empresa.</p>
        )}
      </div>

      {/* Convites Pendentes */}
      {isAdmin && invites.length > 0 && (
        <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-blue-950">
            <MailPlus className="w-4 h-4 text-blue-700" />
            Convites Pendentes para {companyName} ({invites.length})
          </div>
          <div className="divide-y divide-blue-200/70">
            {invites.map((inv) => (
              <div key={inv.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div>
                  <span className="font-semibold text-slate-900">{inv.name}</span>{' '}
                  <span className="text-slate-600">({inv.email})</span> ·{' '}
                  <span className="font-semibold text-blue-800">{inv.role}</span>
                  {inv.department && <span className="text-slate-500"> · {inv.department}</span>}
                </div>
                <button
                  type="button"
                  onClick={() => void handleCancelInvite(inv)}
                  className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer self-start sm:self-auto"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Cancelar convite
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="w-6 h-6" />}
          title="Nenhum usuário encontrado"
          description="Convide colaboradores da sua equipe pelo botão acima para conceder acesso isolado a esta empresa."
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-5 py-3">Usuário</th>
                  <th className="text-left font-medium px-4 py-3">Departamento</th>
                  <th className="text-left font-medium px-4 py-3">Perfil de Acesso</th>
                  <th className="text-left font-medium px-4 py-3">Situação</th>
                  <th className="text-left font-medium px-4 py-3">Módulos Liberados</th>
                  {isAdmin && <th className="text-right font-medium px-5 py-3">Ações</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((prof) => {
                  const countPerms =
                    prof.role === 'ADMINISTRADOR' ? ALL_MENU_SECTIONS.length : prof.permissions.length;
                  return (
                    <tr key={prof.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{prof.name}</p>
                        <p className="text-xs text-slate-500">{prof.email}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{prof.department || '—'}</td>
                      <td className="px-4 py-3 text-xs font-semibold text-blue-800 whitespace-nowrap">
                        {ROLE_LABELS[prof.role]}
                      </td>
                      <td className="px-4 py-3 text-xs font-medium whitespace-nowrap">
                        <span className={prof.active ? 'text-emerald-700' : 'text-red-700'}>
                          {prof.active ? 'Ativo' : 'Bloqueado'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono tabular-nums text-slate-600">
                        {countPerms} de {ALL_MENU_SECTIONS.length} áreas
                      </td>
                      {isAdmin && (
                        <td className="px-5 py-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openEdit(prof)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            Gerenciar
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Editar Permissões */}
      <Modal
        open={Boolean(editingMember)}
        title="Gerenciar Perfil e Permissões"
        subtitle={editingMember?.email}
        onClose={() => setEditingMember(null)}
      >
        <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nome *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.userName}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.department}
                value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}
                placeholder="Ex.: Engenharia / Financeiro / Campo"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Perfil de Acesso</label>
              <select
                value={form.role}
                onChange={(e) => {
                  const newRole = e.target.value as UserRole;
                  setForm({
                    ...form,
                    role: newRole,
                    permissions: [...ROLE_DEFAULT_PERMISSIONS[newRole]],
                  });
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {(Object.keys(ROLE_LABELS) as UserRole[]).map((roleKey) => (
                  <option key={roleKey} value={roleKey}>
                    {ROLE_LABELS[roleKey]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end pb-2">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Membro ativo nesta empresa
              </label>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-700 mb-2">
              Áreas Autorizadas no Menu Principal
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              {ALL_MENU_SECTIONS.map((sec) => (
                <label
                  key={sec.id}
                  className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer py-1"
                >
                  <input
                    type="checkbox"
                    checked={form.permissions.includes(sec.id)}
                    onChange={() => togglePermission(sec.id)}
                  />
                  {sec.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setEditingMember(null)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Salvando...' : 'Salvar Permissões'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Convidar Usuário */}
      <Modal
        open={inviteModalOpen}
        title="Convidar Usuário para Empresa"
        subtitle={`Empresa: ${companyName}`}
        onClose={() => setInviteModalOpen(false)}
      >
        <form onSubmit={(e) => void handleCreateInvite(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Nome Completo *</label>
            <input
              type="text"
              required
              maxLength={FIELD_LIMITS.userName}
              value={inviteForm.name}
              onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })}
              placeholder="Ex.: Carlos Técnico"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">E-mail de Acesso *</label>
            <input
              type="email"
              required
              maxLength={FIELD_LIMITS.userEmail}
              value={inviteForm.email}
              onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
              placeholder="colaborador@empresa.com"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Perfil de Acesso *</label>
              <select
                value={inviteForm.role}
                onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as UserRole })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {(Object.keys(ROLE_LABELS) as UserRole[]).map((roleKey) => (
                  <option key={roleKey} value={roleKey}>
                    {ROLE_LABELS[roleKey]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.department}
                value={inviteForm.department}
                onChange={(e) => setInviteForm({ ...inviteForm, department: e.target.value })}
                placeholder="Ex.: Estoque / Financeiro"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed">
            {ROLE_DESCRIPTIONS[inviteForm.role]}
          </p>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setInviteModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Registrando...' : 'Enviar Convite'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
