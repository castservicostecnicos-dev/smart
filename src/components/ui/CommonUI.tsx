import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Info,
  Loader2,
  WifiOff,
  X,
} from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  text: string;
}

export const ToastBanner: React.FC<{
  toast: ToastMessage | null;
  onDismiss: () => void;
}> = ({ toast, onDismiss }) => {
  if (!toast) return null;

  const styles =
    toast.type === 'success'
      ? 'bg-emerald-950 text-white border-emerald-800'
      : toast.type === 'error'
        ? 'bg-red-950 text-white border-red-800'
        : 'bg-[#0B1F3A] text-white border-blue-900';

  const Icon =
    toast.type === 'success'
      ? CheckCircle2
      : toast.type === 'error'
        ? AlertCircle
        : Info;

  return (
    <div
      role="status"
      className={`fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 z-50 sm:max-w-md border rounded-lg px-4 py-3 shadow-lg flex items-center gap-3 ${styles}`}
    >
      <Icon className="w-5 h-5 shrink-0" />
      <p className="text-sm font-medium flex-1 min-w-0 break-words">{toast.text}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Fechar aviso"
        className="p-1 rounded hover:bg-white/10 transition-colors cursor-pointer"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export const Modal: React.FC<{
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}> = ({ open, title, subtitle, onClose, children, maxWidth = 'max-w-2xl' }) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-[1px] p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`w-full min-w-0 ${maxWidth} bg-white border border-slate-200 rounded-xl shadow-xl my-4 sm:my-8 overflow-hidden`}
      >
        <div className="flex items-start justify-between gap-4 px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50/70">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900 break-words">{title}</h2>
            {subtitle && (
              <p className="text-xs text-slate-500 mt-0.5 break-all">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar janela"
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-200/60 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 sm:p-6 max-h-[80vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="alertdialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-xl p-6">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-600 mt-2 leading-relaxed">{message}</p>
        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-700 hover:bg-blue-800'
            }`}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ icon, title, description, actionLabel, onAction }) => (
  <div className="bg-white border border-slate-200 rounded-xl py-12 px-6 text-center flex flex-col items-center">
    <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center mb-4">
      {icon}
    </div>
    <h3 className="text-base font-semibold text-slate-900">{title}</h3>
    <p className="text-sm text-slate-500 mt-1.5 max-w-md leading-relaxed">
      {description}
    </p>
    {actionLabel && onAction && (
      <button
        type="button"
        onClick={onAction}
        className="mt-5 px-4 py-2.5 bg-blue-700 text-white text-sm font-medium rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        {actionLabel}
      </button>
    )}
  </div>
);

export const SkeletonTable: React.FC<{ rows?: number }> = ({ rows = 5 }) => (
  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
    <div className="h-11 bg-slate-50 border-b border-slate-200 px-4 flex items-center gap-4">
      <div className="h-3.5 w-32 bg-slate-200 rounded animate-pulse" />
      <div className="h-3.5 w-48 bg-slate-200 rounded animate-pulse" />
      <div className="h-3.5 w-24 bg-slate-200 rounded animate-pulse ml-auto" />
    </div>
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-11 px-4 flex items-center gap-4">
          <div className="h-3.5 w-28 bg-slate-100 rounded animate-pulse" />
          <div className="h-3.5 w-56 bg-slate-100 rounded animate-pulse" />
          <div className="h-3.5 w-20 bg-slate-100 rounded animate-pulse ml-auto" />
        </div>
      ))}
    </div>
  </div>
);

export const PWAInstallButton: React.FC<{ variant?: 'topbar' | 'card' }> = ({
  variant = 'topbar',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    if (variant === 'card') {
      return (
        <div className="text-sm text-emerald-700 font-medium flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          Aplicativo já instalado neste dispositivo
        </div>
      );
    }
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="w-3.5 h-3.5" />
        Instalar App
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          Instalar no iOS
        </button>

        <Modal
          open={showIOSGuide}
          title="Instalar no iPhone ou iPad"
          onClose={() => setShowIOSGuide(false)}
          maxWidth="max-w-sm"
        >
          <ol className="text-sm text-slate-700 space-y-2 list-decimal list-inside">
            <li>Toque no botão <strong>Compartilhar</strong> na barra do Safari.</li>
            <li>Role as opções e selecione <strong>Adicionar à Tela de Início</strong>.</li>
            <li>Confirme tocando em <strong>Adicionar</strong>.</li>
          </ol>
        </Modal>
      </>
    );
  }

  if (variant === 'card') {
    return (
      <p className="text-xs text-slate-600">
        Para instalar como aplicativo no computador ou Android, utilize o menu do navegador (Instalar aplicativo / Adicionar à tela inicial).
      </p>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:right-auto z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
      <WifiOff className="w-4 h-4 shrink-0" />
      <span className="break-words">Modo offline — exibindo dados em cache local.</span>
    </div>
  );
};
