'use client';

import { Modal } from './modal';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
}

/**
 * Small confirmation prompt used before destructive or irreversible actions
 * (deleting stock, deactivating staff, removing a patient).
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`${tone === 'danger' ? 'btn-danger' : 'btn-primary'} btn-sm`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <div className="spinner" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-gray-600">{message}</p>
    </Modal>
  );
}
