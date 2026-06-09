'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppSidebar from '@/components/AppSidebar';
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

// Suggested default Tally voucher type names per category
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

  // Per-category edit state: category → current input value
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

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  const loadData = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try {
      const data = await loadVoucherTypes(company.id);
      setRecords(data);
      // Populate inputs from saved records
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
      await loadData();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 p-8 max-w-3xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Voucher Types</h1>
          <p className="text-sm text-gray-500 mt-1">
            Maps each type of purchase to the exact Tally Voucher Type name.
            The voucher type appears in every XML voucher as{' '}
            <code className="bg-gray-100 px-1 rounded text-xs font-mono">VOUCHERTYPENAME</code>.
          </p>
        </div>

        {/* How it works */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-800 mb-6">
          <p className="font-semibold mb-1">How the mapping works</p>
          <ul className="list-disc list-inside space-y-1 text-blue-700 text-xs">
            <li><strong>GST Purchase</strong> - invoice has CGST, SGST, or IGST &gt; 0 → use this voucher type</li>
            <li><strong>Non-GST / Exempt</strong> - invoice has no GST → use this voucher type</li>
            <li><strong>Default / Fallback</strong> - used if no specific category matches</li>
          </ul>
          <p className="mt-2 text-xs text-blue-600">
            If a category has no mapping, the system falls back to <code className="bg-blue-100 px-1 rounded font-mono">Purchase</code> (Tally built-in).
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" />
          </div>
        ) : (
          <div className="space-y-4">
            {PURCHASE_CATEGORIES.map((category) => {
              const existing = records.find((r) => r.purchase_category === category);
              const isSaved = !!existing;
              return (
                <div key={category} className="bg-white border border-gray-200 rounded-xl p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">
                        {PURCHASE_CATEGORY_LABELS[category]}
                      </p>
                      {isSaved ? (
                        <p className="text-xs text-green-600 font-medium mt-0.5">
                          ✓ Mapped to &ldquo;<span className="font-mono">{existing.tally_voucher_type_name}</span>&rdquo;
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-0.5">Not configured - falls back to &ldquo;Purchase&rdquo;</p>
                      )}
                    </div>
                    {isSaved && (
                      <button
                        onClick={() => handleDelete(category)}
                        className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
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
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors[category] && (
                        <p className="text-xs text-red-600 mt-1">{errors[category]}</p>
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
                      <span className="text-xs text-green-600 font-medium shrink-0">✓ Saved</span>
                    )}
                  </div>

                  {/* Suggest button if input is empty */}
                  {!inputs[category] && (
                    <button
                      onClick={() => setInputs((p) => ({ ...p, [category]: DEFAULT_SUGGESTIONS[category] }))}
                      className="mt-2 text-xs text-indigo-600 hover:underline"
                    >
                      Use suggestion: &ldquo;{DEFAULT_SUGGESTIONS[category]}&rdquo;
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Import tip */}
        <div className="mt-6 bg-gray-50 border border-gray-200 rounded-xl px-5 py-4 text-xs text-gray-600">
          <p className="font-semibold text-gray-700 mb-1">How to find your Voucher Type names in Tally</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open Tally → Gateway of Tally → Accounts Info → Voucher Types → Display</li>
            <li>Note the exact names as shown (case-sensitive)</li>
            <li>Enter them above - they will be used verbatim in the exported XML</li>
          </ol>
        </div>
      </main>
    </div>
  );
}
