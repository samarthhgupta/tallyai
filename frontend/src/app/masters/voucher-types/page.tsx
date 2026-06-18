'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppLayout from '@/components/AppLayout';
import { getSession } from '@/lib/auth';
import { useCompany } from '@/lib/companyContext';
import {
  loadVoucherTypes,
  upsertVoucherType,
  deleteVoucherType,
  PURCHASE_CATEGORIES,
  PURCHASE_CATEGORY_LABELS,
  type VoucherTypeMaster,
  type PurchaseCategory,
} from '@/lib/voucherTypes';

const DEFAULT_SUGGESTIONS: Record<PurchaseCategory, string> = {
  gst:     'Purchase GST',
  non_gst: 'Purchase',
  default: 'Purchase',
};

export default function VoucherTypesPage() {
  const { company, loading: companyLoading } = useCompany();
  const router = useRouter();
  const [records, setRecords] = useState<VoucherTypeMaster[]>([]);
  const [loading, setLoading] = useState(false);

  const [inputs, setInputs] = useState<Record<PurchaseCategory, string>>({
    gst: '', non_gst: '', default: '',
  });
  const [saving, setSaving] = useState<Record<PurchaseCategory, boolean>>({
    gst: false, non_gst: false, default: false,
  });
  const [saved, setSaved] = useState<Record<PurchaseCategory, boolean>>({
    gst: false, non_gst: false, default: false,
  });
  const [errors, setErrors] = useState<Record<PurchaseCategory, string>>({
    gst: '', non_gst: '', default: '',
  });

  const [selectedCategories, setSelectedCategories] = useState<Set<PurchaseCategory>>(new Set());
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  useEffect(() => { setSelectedCategories(new Set()); }, [company?.id]);

  const loadData = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try {
      const data = await loadVoucherTypes(company.id);
      setRecords(data);
      const next = { gst: '', non_gst: '', default: '' };
      for (const r of data) {
        next[r.purchase_category] = r.tally_voucher_type_name;
      }
      setInputs(next);
    } finally {
      setLoading(false);
    }
  }, [company?.id]);

  useEffect(() => { loadData(); }, [loadData]);

  const toggleSelectCategory = (category: PurchaseCategory) => {
    const record = records.find((r) => r.purchase_category === category);
    if (!record) return;
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    setBulkDeleting(true);
    try {
      await Promise.all(Array.from(selectedCategories).map((cat) => {
        const record = records.find((r) => r.purchase_category === cat);
        if (!record) return Promise.resolve();
        return deleteVoucherType(record.id);
      }));
      setSelectedCategories(new Set());
      setShowBulkConfirm(false);
      await loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete some mappings.');
      setShowBulkConfirm(false);
      await loadData();
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleSave = async (category: PurchaseCategory) => {
    if (!company?.id) return;
    const name = inputs[category].trim();
    if (!name) {
      setErrors((p) => ({ ...p, [category]: 'Voucher type name is required.' }));
      return;
    }
    setSaving((p) => ({ ...p, [category]: true }));
    setErrors((p) => ({ ...p, [category]: '' }));
    try {
      await upsertVoucherType(company.id, { purchase_category: category, tally_voucher_type_name: inputs[category] });
      setSaved((p) => ({ ...p, [category]: true }));
      setTimeout(() => setSaved((p) => ({ ...p, [category]: false })), 3000);
      await loadData();
    } catch (e: unknown) {
      setErrors((p) => ({ ...p, [category]: e instanceof Error ? e.message : 'Save failed' }));
    } finally {
      setSaving((p) => ({ ...p, [category]: false }));
    }
  };

  const handleDelete = async (category: PurchaseCategory) => {
    const record = records.find((r) => r.purchase_category === category);
    if (!record) return;
    if (!confirm(`Remove mapping for "${PURCHASE_CATEGORY_LABELS[category]}"? The system will fall back to "Purchase" for this category.`)) return;
    try {
      await deleteVoucherType(record.id);
      setInputs((p) => ({ ...p, [category]: '' }));
      setSelectedCategories((prev) => { const next = new Set(prev); next.delete(category); return next; });
      await loadData();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const savedCategories = PURCHASE_CATEGORIES.filter((cat) => records.find((r) => r.purchase_category === cat));

  return (
    <AppLayout>
      <main className="flex-1 p-8 max-w-3xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Voucher Types</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Maps each type of purchase to the exact Tally Voucher Type name.
            The voucher type appears in every XML voucher as{' '}
            <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded text-xs font-mono">VOUCHERTYPENAME</code>.
          </p>
        </div>

        {/* How it works */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl px-5 py-4 text-sm text-blue-800 dark:text-blue-300 mb-6">
          <p className="font-semibold mb-1">How the mapping works</p>
          <ul className="list-disc list-inside space-y-1 text-blue-700 dark:text-blue-300 text-xs">
            <li><strong>GST Purchase</strong> - invoice has CGST, SGST, or IGST &gt; 0 → use this voucher type</li>
            <li><strong>Non-GST / Exempt</strong> - invoice has no GST → use this voucher type</li>
            <li><strong>Default / Fallback</strong> - used if no specific category matches</li>
          </ul>
          <p className="mt-2 text-xs text-blue-600 dark:text-blue-400">
            If a category has no mapping, the system falls back to <code className="bg-blue-100 px-1 rounded font-mono">Purchase</code> (Tally built-in).
          </p>
        </div>

        {/* ── Bulk action bar ── */}
        {selectedCategories.size > 0 && (
          <div className="flex items-center gap-3 mb-4 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <span className="text-sm text-red-700 dark:text-red-400 font-medium">{selectedCategories.size} selected</span>
            <button onClick={() => setShowBulkConfirm(true)}
              className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 font-medium">
              Remove Selected ({selectedCategories.size})
            </button>
            <button onClick={() => setSelectedCategories(new Set())}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 ml-auto">
              Cancel
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" />
          </div>
        ) : (
          <div className="space-y-4">
            {PURCHASE_CATEGORIES.map((category) => {
              const existing = records.find((r) => r.purchase_category === category);
              const isSaved = !!existing;
              const isSelected = selectedCategories.has(category);
              return (
                <div key={category} className={`bg-white dark:bg-gray-800 border rounded-xl p-5 transition-colors ${isSelected ? 'border-red-300 bg-red-50 dark:bg-red-900/20' : 'border-gray-200 dark:border-gray-700'}`}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-start gap-3">
                      {isSaved && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectCategory(category)}
                          className="mt-0.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                        />
                      )}
                      <div>
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                          {PURCHASE_CATEGORY_LABELS[category]}
                        </p>
                        {isSaved ? (
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium mt-0.5">
                            ✓ Mapped to &ldquo;<span className="font-mono">{existing.tally_voucher_type_name}</span>&rdquo;
                          </p>
                        ) : (
                          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Not configured - falls back to &ldquo;Purchase&rdquo;</p>
                        )}
                      </div>
                    </div>
                    {isSaved && (
                      <button
                        onClick={() => handleDelete(category)}
                        className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 font-medium transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <input
                        type="text"
                        value={inputs[category]}
                        onChange={(e) => setInputs((p) => ({ ...p, [category]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && handleSave(category)}
                        placeholder={`e.g. ${DEFAULT_SUGGESTIONS[category]}`}
                        className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 dark:bg-gray-700 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors[category] && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1">{errors[category]}</p>
                      )}
                    </div>
                    <button
                      disabled={saving[category] || !company?.id}
                      onClick={() => handleSave(category)}
                      className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors shrink-0"
                    >
                      {saving[category] ? 'Saving…' : isSaved ? 'Update' : 'Save'}
                    </button>
                    {saved[category] && (
                      <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">✓ Saved</span>
                    )}
                  </div>

                  {!inputs[category] && (
                    <button
                      onClick={() => setInputs((p) => ({ ...p, [category]: DEFAULT_SUGGESTIONS[category] }))}
                      className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      Use suggestion: &ldquo;{DEFAULT_SUGGESTIONS[category]}&rdquo;
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {savedCategories.length > 1 && selectedCategories.size === 0 && (
          <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
            Select checkboxes on configured mappings to bulk remove them.
          </p>
        )}

        <div className="mt-6 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-5 py-4 text-xs text-gray-600 dark:text-gray-400">
          <p className="font-semibold text-gray-700 dark:text-gray-300 mb-1">How to find your Voucher Type names in Tally</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open Tally → Gateway of Tally → Accounts Info → Voucher Types → Display</li>
            <li>Note the exact names as shown (case-sensitive)</li>
            <li>Enter them above - they will be used verbatim in the exported XML</li>
          </ol>
        </div>
      </main>

      {/* ── Bulk delete confirmation modal ── */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Remove {selectedCategories.size} mapping{selectedCategories.size !== 1 ? 's' : ''}?</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">The system will fall back to &ldquo;Purchase&rdquo; for removed categories.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowBulkConfirm(false)} disabled={bulkDeleting}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900">
                Cancel
              </button>
              <button onClick={handleBulkDelete} disabled={bulkDeleting}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors">
                {bulkDeleting ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
