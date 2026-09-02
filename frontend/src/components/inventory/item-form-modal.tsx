'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';

export interface InventoryItem {
  id: string;
  product_name: string;
  product_code: string;
  generic_name: string | null;
  category: string | null;
  manufacturer: string | null;
  batch_number: string | null;
  quantity: number;
  unit_price: string | number;
  cost_price: string | number;
  expiry_date: string;
  reorder_level: number;
  shelf_location: string | null;
  barcode: string | null;
  requires_prescription: boolean;
}

interface ItemFormModalProps {
  open: boolean;
  item: InventoryItem | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY_FORM = {
  product_name: '',
  product_code: '',
  generic_name: '',
  category: '',
  manufacturer: '',
  batch_number: '',
  quantity: '0',
  unit_price: '',
  cost_price: '',
  expiry_date: '',
  reorder_level: '10',
  shelf_location: '',
  barcode: '',
  requires_prescription: false,
};

/** Only the date portion of an ISO timestamp — needed for <input type="date">. */
function toDateInput(value: string | null | undefined) {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

export function ItemFormModal({ open, item, categories, onClose, onSaved }: ItemFormModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const isEdit = !!item;

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    if (item) {
      setForm({
        product_name: item.product_name || '',
        product_code: item.product_code || '',
        generic_name: item.generic_name || '',
        category: item.category || '',
        manufacturer: item.manufacturer || '',
        batch_number: item.batch_number || '',
        quantity: String(item.quantity ?? 0),
        unit_price: String(item.unit_price ?? ''),
        cost_price: String(item.cost_price ?? ''),
        expiry_date: toDateInput(item.expiry_date),
        reorder_level: String(item.reorder_level ?? 10),
        shelf_location: item.shelf_location || '',
        barcode: item.barcode || '',
        requires_prescription: !!item.requires_prescription,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, item]);

  const set = (field: keyof typeof EMPTY_FORM, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const errors = {
    product_name: form.product_name.trim() === '' ? 'Product name is required' : '',
    product_code: form.product_code.trim() === '' ? 'Product code is required' : '',
    quantity: !/^\d+$/.test(form.quantity.trim()) ? 'Quantity must be a whole number' : '',
    unit_price: !(Number(form.unit_price) >= 0) ? 'Unit price must be 0 or more' : '',
    cost_price: !(Number(form.cost_price) >= 0) ? 'Cost price must be 0 or more' : '',
    expiry_date: form.expiry_date === '' ? 'Expiry date is required' : '',
    reorder_level: !/^\d+$/.test(form.reorder_level.trim()) ? 'Reorder level must be a whole number' : '',
  };
  const hasErrors = Object.values(errors).some(Boolean);

  const handleSubmit = async () => {
    setTouched(true);
    if (hasErrors) return;

    setSubmitting(true);
    try {
      const payload = {
        product_name: form.product_name.trim(),
        product_code: form.product_code.trim(),
        generic_name: form.generic_name.trim() || null,
        category: form.category.trim() || null,
        manufacturer: form.manufacturer.trim() || null,
        batch_number: form.batch_number.trim() || null,
        quantity: parseInt(form.quantity, 10),
        unit_price: parseFloat(form.unit_price),
        cost_price: parseFloat(form.cost_price),
        expiry_date: form.expiry_date,
        reorder_level: parseInt(form.reorder_level, 10),
        shelf_location: form.shelf_location.trim() || null,
        barcode: form.barcode.trim() || null,
        requires_prescription: form.requires_prescription,
      };

      if (isEdit) {
        await api.put(`/inventory/${item!.id}`, payload);
        toast.success('Item updated');
      } else {
        await api.post('/inventory', payload);
        toast.success('Item added to inventory');
      }
      onSaved();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save item');
    } finally {
      setSubmitting(false);
    }
  };

  const errorFor = (field: keyof typeof errors) => (touched ? errors[field] : '');

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title={isEdit ? 'Edit inventory item' : 'Add inventory item'}
      description={
        isEdit
          ? 'Update stock details, pricing or batch information'
          : 'Record a new product or a new batch of an existing product'
      }
      size="lg"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
            {submitting && <div className="spinner" />}
            {isEdit ? 'Save changes' : 'Add item'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Product name *</label>
            <input
              type="text"
              className={`input ${errorFor('product_name') ? 'input-error' : ''}`}
              placeholder="e.g. Paracetamol 500mg"
              value={form.product_name}
              onChange={(e) => set('product_name', e.target.value)}
            />
            {errorFor('product_name') && (
              <p className="text-xs text-red-600 mt-1">{errorFor('product_name')}</p>
            )}
          </div>
          <div>
            <label className="label">Product code *</label>
            <input
              type="text"
              className={`input ${errorFor('product_code') ? 'input-error' : ''}`}
              placeholder="e.g. PCM-500-100"
              value={form.product_code}
              onChange={(e) => set('product_code', e.target.value)}
            />
            {errorFor('product_code') && (
              <p className="text-xs text-red-600 mt-1">{errorFor('product_code')}</p>
            )}
            {!isEdit && (
              <p className="text-xs text-gray-400 mt-1">
                Codes must be unique per pharmacy. Use a distinct code for each batch.
              </p>
            )}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Generic name</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. Acetaminophen"
              value={form.generic_name}
              onChange={(e) => set('generic_name', e.target.value)}
            />
          </div>
          <div>
            <label className="label">Category</label>
            <input
              type="text"
              className="input"
              list="inventory-categories"
              placeholder="e.g. Analgesics"
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
            />
            <datalist id="inventory-categories">
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Manufacturer</label>
            <input
              type="text"
              className="input"
              value={form.manufacturer}
              onChange={(e) => set('manufacturer', e.target.value)}
            />
          </div>
          <div>
            <label className="label">Batch / lot number</label>
            <input
              type="text"
              className="input"
              placeholder="Required for regulatory traceability"
              value={form.batch_number}
              onChange={(e) => set('batch_number', e.target.value)}
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Quantity *</label>
            <input
              type="number"
              min="0"
              className={`input ${errorFor('quantity') ? 'input-error' : ''}`}
              value={form.quantity}
              onChange={(e) => set('quantity', e.target.value)}
            />
            {errorFor('quantity') && <p className="text-xs text-red-600 mt-1">{errorFor('quantity')}</p>}
          </div>
          <div>
            <label className="label">Reorder level *</label>
            <input
              type="number"
              min="0"
              className={`input ${errorFor('reorder_level') ? 'input-error' : ''}`}
              value={form.reorder_level}
              onChange={(e) => set('reorder_level', e.target.value)}
            />
            {errorFor('reorder_level') && (
              <p className="text-xs text-red-600 mt-1">{errorFor('reorder_level')}</p>
            )}
          </div>
          <div>
            <label className="label">Expiry date *</label>
            <input
              type="date"
              className={`input ${errorFor('expiry_date') ? 'input-error' : ''}`}
              value={form.expiry_date}
              onChange={(e) => set('expiry_date', e.target.value)}
            />
            {errorFor('expiry_date') && (
              <p className="text-xs text-red-600 mt-1">{errorFor('expiry_date')}</p>
            )}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Unit price (GHS) *</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className={`input ${errorFor('unit_price') ? 'input-error' : ''}`}
              value={form.unit_price}
              onChange={(e) => set('unit_price', e.target.value)}
            />
            {errorFor('unit_price') && <p className="text-xs text-red-600 mt-1">{errorFor('unit_price')}</p>}
          </div>
          <div>
            <label className="label">Cost price (GHS) *</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className={`input ${errorFor('cost_price') ? 'input-error' : ''}`}
              value={form.cost_price}
              onChange={(e) => set('cost_price', e.target.value)}
            />
            {errorFor('cost_price') && <p className="text-xs text-red-600 mt-1">{errorFor('cost_price')}</p>}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Shelf location</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. Aisle 2, Shelf B"
              value={form.shelf_location}
              onChange={(e) => set('shelf_location', e.target.value)}
            />
          </div>
          <div>
            <label className="label">Barcode</label>
            <input
              type="text"
              className="input"
              value={form.barcode}
              onChange={(e) => set('barcode', e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 rounded border-gray-300 text-primary-600"
            checked={form.requires_prescription}
            onChange={(e) => set('requires_prescription', e.target.checked)}
          />
          <div>
            <div className="text-sm font-medium text-gray-900">Prescription only</div>
            <div className="text-xs text-gray-500">A valid prescription must be recorded before dispensing</div>
          </div>
        </label>
      </div>
    </Modal>
  );
}
