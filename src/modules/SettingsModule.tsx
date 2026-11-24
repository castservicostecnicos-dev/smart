import React, { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Activity,
  AlertCircle,
  Building2,
  CheckCircle2,
  Database,
  Plus,
  Save,
  Shield,
  Smartphone,
} from 'lucide-react';
import { FIREBASE_RUNTIME_INFO, testConnection } from '../lib/firebase';
import {
  FIELD_LIMITS,
  type CompanySettings,
  type TaxRegime,
} from '../types/erp';
import { saveCompanySettings, type SettingsInput } from '../services/erpService';
import { PWAInstallButton } from '../components/ui/CommonUI';

interface SettingsModuleProps {
  user: User;
  companyId: string;
  canEdit: boolean;
  settings: CompanySettings | null;
  onCreateCompany: () => void;
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

export const SettingsModule: React.FC<SettingsModuleProps> = ({
  user,
  companyId,
  canEdit,
  settings,
  onCreateCompany,
  onNotify,
}) => {
  const [form, setForm] = useState<SettingsInput>({
    razaoSocial: settings?.razaoSocial ?? '',
    nomeFantasia: settings?.nomeFantasia ?? '',
    cnpj: settings?.cnpj ?? '',
    inscricaoEstadual: settings?.inscricaoEstadual ?? '',
    telefone: settings?.telefone ?? '',
    email: settings?.email ?? user.email ?? '',
    endereco: settings?.endereco ?? '',
    regimeTributario: settings?.regimeTributario ?? 'Simples Nacional',
    diasToleranciaConciliacao: settings?.diasToleranciaConciliacao ?? 5,
    serieNfPadrao: settings?.serieNfPadrao ?? '1',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<{
    ok: boolean;
    latencyMs: number;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (settings) {
      setForm({
        razaoSocial: settings.razaoSocial,
        nomeFantasia: settings.nomeFantasia,
        cnpj: settings.cnpj ?? '',
        inscricaoEstadual: settings.inscricaoEstadual ?? '',
        telefone: settings.telefone ?? '',
        email: settings.email ?? '',
        endereco: settings.endereco ?? '',
        regimeTributario: settings.regimeTributario,
        diasToleranciaConciliacao: settings.diasToleranciaConciliacao,
        serieNfPadrao: settings.serieNfPadrao,
      });
    }
  }, [settings]);

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.razaoSocial.trim()) errs.razaoSocial = 'Informe a Razão Social da empresa.';
    if (!form.nomeFantasia.trim()) errs.nomeFantasia = 'Informe o Nome Fantasia.';
    if (!form.serieNfPadrao.trim()) errs.serieNfPadrao = 'Informe a série padrão de NF.';
    if (form.diasToleranciaConciliacao < 0 || form.diasToleranciaConciliacao > 90) {
      errs.diasToleranciaConciliacao = 'Informe entre 0 e 90 dias.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !validate() || saving) return;

    setSaving(true);
    try {
      await saveCompanySettings(user, companyId, form);
      onNotify('success', 'Configurações empresariais salvas no Firebase.');
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar configurações.');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    try {
      const res = await testConnection();
      setConnResult(res);
      onNotify(res.ok ? 'success' : 'error', res.message);
    } finally {
      setTestingConn(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Cadastro da Empresa e Parâmetros Operacionais
              </h2>
              <p className="text-xs text-slate-500">
                ID da Empresa: <span className="font-mono">{companyId}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onCreateCompany}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer self-start sm:self-auto"
          >
            <Plus className="w-3.5 h-3.5" />
            Nova Empresa
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <fieldset disabled={!canEdit} className="space-y-4 disabled:opacity-75">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Razão Social *</label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.razaoSocial}
                  value={form.razaoSocial}
                  onChange={(e) => setForm({ ...form, razaoSocial: e.target.value })}
                  placeholder="Ex.: ClimaTech Refrigeração e Serviços Ltda"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                {errors.razaoSocial && <p className="text-xs text-red-600 mt-1">{errors.razaoSocial}</p>}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Nome Fantasia *</label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.nomeFantasia}
                  value={form.nomeFantasia}
                  onChange={(e) => setForm({ ...form, nomeFantasia: e.target.value })}
                  placeholder="Ex.: ClimaTech Climatização"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                {errors.nomeFantasia && <p className="text-xs text-red-600 mt-1">{errors.nomeFantasia}</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">CNPJ</label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.cnpj}
                  value={form.cnpj ?? ''}
                  onChange={(e) => setForm({ ...form, cnpj: e.target.value })}
                  placeholder="00.000.000/0001-00"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Inscrição Estadual</label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.inscricaoEstadual}
                  value={form.inscricaoEstadual ?? ''}
                  onChange={(e) => setForm({ ...form, inscricaoEstadual: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Regime Tributário *</label>
                <select
                  value={form.regimeTributario}
                  onChange={(e) => setForm({ ...form, regimeTributario: e.target.value as TaxRegime })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Simples Nacional">Simples Nacional</option>
                  <option value="Lucro Presumido">Lucro Presumido</option>
                  <option value="Lucro Real">Lucro Real</option>
                  <option value="MEI">MEI</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Telefone Comercial</label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.telefone}
                  value={form.telefone ?? ''}
                  onChange={(e) => setForm({ ...form, telefone: e.target.value })}
                  placeholder="(11) 99999-9999"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">E-mail Corporativo</label>
                <input
                  type="email"
                  maxLength={FIELD_LIMITS.userEmail}
                  value={form.email ?? ''}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Endereço Completo</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.endereco}
                value={form.endereco ?? ''}
                onChange={(e) => setForm({ ...form, endereco: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tolerância de Conciliação Bancária (dias)
                </label>
                <input
                  type="number"
                  min="0"
                  max="90"
                  value={form.diasToleranciaConciliacao}
                  onChange={(e) =>
                    setForm({ ...form, diasToleranciaConciliacao: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
                />
                {errors.diasToleranciaConciliacao && (
                  <p className="text-xs text-red-600 mt-1">{errors.diasToleranciaConciliacao}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Série Padrão de NF-e / NFS-e *
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.serieNf}
                  value={form.serieNfPadrao}
                  onChange={(e) => setForm({ ...form, serieNfPadrao: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
                {errors.serieNfPadrao && (
                  <p className="text-xs text-red-600 mt-1">{errors.serieNfPadrao}</p>
                )}
              </div>
            </div>
          </fieldset>

          {canEdit && (
            <div className="flex justify-end pt-4">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Salvando...' : 'Salvar Configurações'}
              </button>
            </div>
          )}
        </form>
      </div>

      {/* Coluna Direita: Infraestrutura Firebase & PWA */}
      <div className="space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Infraestrutura Firebase</h3>
              <p className="text-xs text-slate-500">Projeto: {FIREBASE_RUNTIME_INFO.projectId}</p>
            </div>
          </div>

          <div className="space-y-2 text-xs text-slate-700 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span>Firebase Authentication</span>
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Ativo
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Cloud Firestore (Tempo Real)</span>
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Regras implantadas
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Firebase Hosting (firebase.json)</span>
              <span className="inline-flex items-center gap-1 text-blue-700 font-medium">
                Configurado
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Firebase App Check (reCAPTCHA v3)</span>
              <span
                className={`inline-flex items-center gap-1 font-medium ${
                  FIREBASE_RUNTIME_INFO.appCheckConfigured ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {FIREBASE_RUNTIME_INFO.appCheckConfigured ? (
                  <>
                    <Shield className="w-3.5 h-3.5" /> Ativo
                  </>
                ) : (
                  'Aguardando VITE_FIREBASE_APPCHECK_SITE_KEY'
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Firebase Storage (storage.rules)</span>
              <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                <AlertCircle className="w-3.5 h-3.5" /> Requer Plano Blaze
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Cloud Functions (Servidor)</span>
              <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                <AlertCircle className="w-3.5 h-3.5" /> Requer Plano Blaze
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={testingConn}
            onClick={() => void handleTestConnection()}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-white bg-[#0B1F3A] rounded-lg hover:bg-blue-900 disabled:opacity-50 cursor-pointer"
          >
            <Activity className="w-3.5 h-3.5" />
            {testingConn ? 'Testando conexão...' : 'Testar Conexão Real Firestore'}
          </button>

          {connResult && (
            <div
              className={`text-xs rounded-lg p-3 border ${
                connResult.ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              {connResult.message}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#0B1F3A] text-white flex items-center justify-center">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Aplicativo Instalável (PWA)</h3>
              <p className="text-xs text-slate-500">Uso em celulares, tablets e computadores</p>
            </div>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            O sistema Gestão Inteligente Empresarial funciona como site e aplicativo instalável com suporte a cache offline e carregamento rápido em campo.
          </p>
          <div className="pt-2">
            <PWAInstallButton variant="card" />
          </div>
        </div>
      </div>
    </div>
  );
};
