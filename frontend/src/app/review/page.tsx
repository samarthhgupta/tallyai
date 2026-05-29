'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import axios from 'axios';
import { supabase } from '@/lib/supabase';
import AuthGuard from '@/components/AuthGuard';
import Navbar from '@/components/Navbar';
import type { Session } from '@supabase/supabase-js';

// GSTIN first-2-digits → state name
const GSTIN_STATE_MAP: Record<string, string> = {
  '01': 'J&K', '02': 'HP', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'UP', '10': 'Bihar',
  '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'WB',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'MP', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'D&NH', '27': 'Maharashtra', '28': 'AP (old)', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'A&N Islands', '36': 'Telangana', '37': 'AP',
};

function getStateFromGstin(gstin: string): string {
  if (!gstin || gstin.length < 2) return 'Unknown';
  return GSTIN_STATE_MAP[gstin.slice(0, 2)] || 'Unknown';
}

interface LineItem {
  description: string;
  hsn: string;
  gst_percent: number;
  qty: number;
  rate: number;       // ex-GST
  disc_percent: number;
  amount?: number;    // computed
}

interface InvoiceData {
  id: string;
  invoice_id: string;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  vendor_gstin: string;
  line_items: LineItem[];
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  round_off: number;
  total: number;
  ai_confidence: number;
  corrected_by_user: boolean;
  tax_type?: 'cgst_sgst' | 'igst';
}

interface Company {
  id: string;
  name: string;
  gstin?: string;
}

function calcRateAfterDisc(rate: number, disc: number) {
  return rate * (1 - disc / 100);
}
function calcAmount(item: LineItem) {
  return item.qty * calcRateAfterDisc(item.rate, item.disc_percent);
}

interface HsnRow {
  hsn: string;
  gst_percent: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

function buildHsnSummary(items: LineItem[], taxType: 'cgst_sgst' | 'igst'): HsnRow[] {
  const map: Record<string, HsnRow> = {};
  for (const item of items) {
    const key = `${item.hsn}__${item.gst_percent}`;
    if (!map[key]) {
      map[key] = { hsn: item.hsn || '—', gst_percent: item.gst_percent, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    }
    const amt = calcAmount(item);
    const tax = amt * item.gst_percent / 100;
    map[key].taxable += amt;
    if (taxType === 'cgst_sgst') {
      map[key].cgst += tax / 2;
      map[key].sgst += tax / 2;
    } else {
      map[key].igst += tax;
    }
  }
  return Object.values(map);
}

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls = pct >= 80 ? 'bg-green-100 text-green-700' : pct >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{pct}% confidence</span>;
}

function InvoiceCard({
  inv,
  companyGstin,
  onUpdate,
  onApprove,
  approved,
}: {
  inv: InvoiceData;
  companyGstin?: string;
  onUpdate: (updated: InvoiceData) => void;
  onApprove: (id: string) => void;
  approved: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<InvoiceData>(inv);

  const vendorState = getStateFromGstin(data.vendor_gstin);
  const companyState = companyGstin ? getStateFromGstin(companyGstin) : null;
  const taxType: 'cgst_sgst' | 'igst' = data.igst > 0 ? 'igst' : 'cgst_sgst';

  // GST type mismatch detection
  const sameState = companyState && vendorState === companyState;
  const gstMismatch = sameState
    ? taxType === 'igst'  // same state but IGST charged
    : taxType === 'cgst_sgst'; // diff state but CGST+SGST charged

  const hsnRows = buildHsnSummary(data.line_items, taxType);

  function updateField<K extends keyof InvoiceData>(key: K, value: InvoiceData[K]) {
    const updated = { ...data, [key]: value };
    setData(updated);
    onUpdate(updated);
  }

  function updateLineItem(idx: number, field: keyof LineItem, value: string | number) {
    const items = data.line_items.map((item, i) =>
      i === idx ? { ...item, [field]: value } : item
    );
    const updated = { ...data, line_items: items };
    setData(updated);
    onUpdate(updated);
  }

  const computedSubtotal = data.line_items.reduce((sum, item) => sum + calcAmount(item), 0);
  const computedTax = hsnRows.reduce((sum, r) => sum + r.cgst + r.sgst + r.igst, 0);
  const computedTotal = computedSubtotal + computedTax + (data.round_off || 0);

  return (
    <div className={`bg-white rounded-lg border shadow-sm overflow-hidden ${approved ? 'border-green-300' : 'border-gray-200'}`}>
      {/* Card header */}
      <div className="px-5 py-4 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-semibold text-gray-900">{data.vendor_name || '—'}</span>
            <span className="text-sm text-gray-500">#{data.invoice_number}</span>
            <span className="text-sm text-gray-400">{data.invoice_date}</span>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {data.vendor_gstin && (
              <span className="text-xs text-gray-500 font-mono">{data.vendor_gstin}</span>
            )}
            {vendorState !== 'Unknown' && (
              <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{vendorState}</span>
            )}
            <ConfidenceBadge score={data.ai_confidence} />
            {approved && (
              <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium">✓ Approved</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-semibold text-gray-900">₹{computedTotal.toFixed(2)}</span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-400 hover:text-gray-700 p-1"
          >
            <svg className={`w-5 h-5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* GST mismatch warning */}
      {gstMismatch && companyState && (
        <div className="mx-5 mb-3 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm text-amber-800">
          ⚠ GST type mismatch: vendor is in <strong>{vendorState}</strong>, company in <strong>{companyState}</strong>,
          but invoice uses <strong>{taxType === 'igst' ? 'IGST' : 'CGST+SGST'}</strong>.
        </div>
      )}

      {/* Expanded view */}
      {expanded && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-5">
          {/* Editable header fields */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Vendor Name', key: 'vendor_name' as const },
              { label: 'Invoice Number', key: 'invoice_number' as const },
              { label: 'Invoice Date', key: 'invoice_date' as const },
              { label: 'Vendor GSTIN', key: 'vendor_gstin' as const },
            ].map(({ label, key }) => (
              <div key={key}>
                <label className="block text-xs text-gray-500 mb-1">{label}</label>
                <input
                  type="text"
                  value={(data[key] as string) || ''}
                  onChange={(e) => updateField(key, e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            ))}
          </div>

          {/* Line items table */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Line Items</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    {['Description', 'HSN', 'GST%', 'Qty', 'Rate (ex-GST)', 'Disc%', 'Rate after disc', 'Amount'].map((h) => (
                      <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.line_items.map((item, i) => {
                    const rad = calcRateAfterDisc(item.rate, item.disc_percent);
                    const amt = item.qty * rad;
                    return (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-2 py-1.5 border border-gray-200">
                          <input
                            type="text"
                            value={item.description}
                            onChange={(e) => updateLineItem(i, 'description', e.target.value)}
                            className="w-full min-w-[120px] focus:outline-none bg-transparent"
                          />
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200">
                          <input
                            type="text"
                            value={item.hsn}
                            onChange={(e) => updateLineItem(i, 'hsn', e.target.value)}
                            className="w-16 focus:outline-none bg-transparent"
                          />
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200">
                          <input
                            type="number"
                            value={item.gst_percent}
                            onChange={(e) => updateLineItem(i, 'gst_percent', parseFloat(e.target.value) || 0)}
                            className="w-14 focus:outline-none bg-transparent text-right"
                          />
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200">
                          <input
                            type="number"
                            value={item.qty}
                            onChange={(e) => updateLineItem(i, 'qty', parseFloat(e.target.value) || 0)}
                            className="w-14 focus:outline-none bg-transparent text-right"
                          />
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200">
                          <input
                            type="number"
                            value={item.rate}
                            onChange={(e) => updateLineItem(i, 'rate', parseFloat(e.target.value) || 0)}
                            className="w-20 focus:outline-none bg-transparent text-right"
                          />
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200">
                          <input
                            type="number"
                            value={item.disc_percent}
                            onChange={(e) => updateLineItem(i, 'disc_percent', parseFloat(e.target.value) || 0)}
                            className="w-14 focus:outline-none bg-transparent text-right"
                          />
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right text-gray-600">
                          {rad.toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right font-medium">
                          ₹{amt.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Tax totals */}
          <div className="flex justify-end">
            <div className="w-64 text-sm space-y-1">
              <div className="flex justify-between text-gray-600">
                <span>Subtotal</span>
                <span>₹{computedSubtotal.toFixed(2)}</span>
              </div>
              {taxType === 'cgst_sgst' ? (
                <>
                  <div className="flex justify-between text-gray-600">
                    <span>CGST</span>
                    <span>₹{(computedTax / 2).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>SGST</span>
                    <span>₹{(computedTax / 2).toFixed(2)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-gray-600">
                  <span>IGST</span>
                  <span>₹{computedTax.toFixed(2)}</span>
                </div>
              )}
              {data.round_off !== 0 && (
                <div className="flex justify-between text-gray-400 text-xs">
                  <span>Round Off</span>
                  <span>₹{(data.round_off || 0).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold text-gray-900 border-t border-gray-200 pt-1">
                <span>Total</span>
                <span>₹{computedTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* HSN Summary */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">HSN & GST Summary</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    {['HSN', 'Taxable Value', 'GST%', 'CGST', 'SGST', 'IGST', 'Total Tax', 'Match'].map((h) => (
                      <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hsnRows.map((row, i) => {
                    const calcTax = row.cgst + row.sgst + row.igst;
                    // Find corresponding vendor-charged tax from original invoice data
                    // We use a tolerance of ₹1
                    const vendorTaxForHsn = (() => {
                      const items = data.line_items.filter(it => it.hsn === row.hsn && it.gst_percent === row.gst_percent);
                      return items.reduce((s, it) => s + calcAmount(it) * it.gst_percent / 100, 0);
                    })();
                    const diff = Math.abs(calcTax - vendorTaxForHsn);
                    const match = diff <= 1;
                    return (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-2 py-1.5 border border-gray-200 font-mono">{row.hsn}</td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right">₹{row.taxable.toFixed(2)}</td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right">{row.gst_percent}%</td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right">{row.cgst > 0 ? `₹${row.cgst.toFixed(2)}` : '—'}</td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right">{row.sgst > 0 ? `₹${row.sgst.toFixed(2)}` : '—'}</td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right">{row.igst > 0 ? `₹${row.igst.toFixed(2)}` : '—'}</td>
                        <td className="px-2 py-1.5 border border-gray-200 text-right font-medium">₹{calcTax.toFixed(2)}</td>
                        <td className="px-2 py-1.5 border border-gray-200">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${match ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {match ? 'Match' : 'Mismatch'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-card approve button */}
          <div className="flex justify-end">
            <button
              onClick={() => onApprove(inv.id)}
              disabled={approved}
              className="px-4 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {approved ? '✓ Approved' : 'Approve'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewContent({ session }: { session: Session }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const batchId = searchParams.get('batch_id');

  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState('');
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    supabase
      .from('companies')
      .select('id, name, gstin')
      .eq('user_id', session.user.id)
      .order('name')
      .then(({ data }) => { if (data) setCompanies(data); });
  }, [session.user.id]);

  useEffect(() => {
    if (!batchId) { setLoading(false); return; }
    supabase
      .from('invoice_data')
      .select('*')
      .eq('batch_id', batchId)
      .then(({ data }) => {
        if (data) setInvoices(data as InvoiceData[]);
        setLoading(false);
      });
  }, [batchId]);

  const handleUpdate = useCallback((updated: InvoiceData) => {
    setInvoices((prev) => prev.map((inv) => inv.id === updated.id ? updated : inv));
  }, []);

  const handleApprove = useCallback((id: string) => {
    setApprovedIds((prev) => { const next = new Set(Array.from(prev)); next.add(id); return next; });
  }, []);

  const handlePushAll = async () => {
    setPushing(true);
    setPushError('');
    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
      const { data: { session: s } } = await supabase.auth.getSession();
      await axios.post(
        `${backendUrl}/invoices/push`,
        { batch_id: batchId, invoice_ids: invoices.map((i) => i.id) },
        { headers: { Authorization: `Bearer ${s?.access_token}` } }
      );
      router.push('/upload');
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setPushError(err.response?.data?.detail || err.message || 'Push failed.');
      } else {
        setPushError('Push failed. Please try again.');
      }
    } finally {
      setPushing(false);
    }
  };

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  if (!batchId) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar companies={companies} selectedCompanyId={selectedCompanyId} onCompanyChange={setSelectedCompanyId} />
        <main className="max-w-4xl mx-auto px-4 py-16 text-center">
          <p className="text-gray-500 text-lg mb-4">No batch selected.</p>
          <button onClick={() => router.push('/upload')} className="text-indigo-600 hover:underline text-sm">
            ← Back to Upload
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <Navbar companies={companies} selectedCompanyId={selectedCompanyId} onCompanyChange={setSelectedCompanyId} />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Batch Review</h2>
            <p className="text-sm text-gray-500 mt-0.5">Batch: <span className="font-mono">{batchId}</span></p>
          </div>
          <button onClick={() => router.push('/upload')} className="text-sm text-gray-500 hover:text-gray-700">
            ← Upload another
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <svg className="animate-spin h-6 w-6 text-indigo-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-20 text-gray-500">No invoices found for this batch.</div>
        ) : (
          <div className="space-y-4">
            {invoices.map((inv) => (
              <InvoiceCard
                key={inv.id}
                inv={inv}
                companyGstin={selectedCompany?.gstin}
                onUpdate={handleUpdate}
                onApprove={handleApprove}
                approved={approvedIds.has(inv.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Sticky bottom bar */}
      {invoices.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-3 flex items-center justify-between shadow-lg z-10">
          <div className="text-sm text-gray-600">
            {approvedIds.size} of {invoices.length} approved
          </div>
          <div className="flex items-center gap-3">
            {pushError && <span className="text-sm text-red-600">{pushError}</span>}
            <button
              onClick={handlePushAll}
              disabled={pushing || approvedIds.size === 0}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {pushing ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Pushing to Tally…
                </>
              ) : (
                'Approve & Push to Tally'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewPageInner() {
  return <AuthGuard>{(session) => <ReviewContent session={session} />}</AuthGuard>;
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><span className="text-gray-400">Loading…</span></div>}>
      <ReviewPageInner />
    </Suspense>
  );
}
