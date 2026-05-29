'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { supabase } from '@/lib/supabase';
import AuthGuard from '@/components/AuthGuard';
import Navbar from '@/components/Navbar';
import type { Session } from '@supabase/supabase-js';

interface Company {
  id: string;
  name: string;
}

interface RecentInvoice {
  id: string;
  file_name: string;
  created_at: string;
  status: string;
  batch_id: string;
}

function UploadContent({ session }: { session: Session }) {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [recentInvoices, setRecentInvoices] = useState<RecentInvoice[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function fetchCompanies() {
      const { data } = await supabase
        .from('companies')
        .select('id, name')
        .eq('user_id', session.user.id)
        .order('name');
      if (data) setCompanies(data);
    }

    async function fetchRecentInvoices() {
      const { data } = await supabase
        .from('invoices')
        .select('id, file_name, created_at, status, batch_id')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (data) setRecentInvoices(data);
    }

    fetchCompanies();
    fetchRecentInvoices();
  }, [session.user.id]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped && isValidFile(dropped)) {
      setFile(dropped);
      setUploadError('');
    } else {
      setUploadError('Please upload a PDF, JPG, JPEG, or PNG file.');
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && isValidFile(selected)) {
      setFile(selected);
      setUploadError('');
    } else if (selected) {
      setUploadError('Please upload a PDF, JPG, JPEG, or PNG file.');
    }
  };

  const isValidFile = (f: File) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    return allowed.includes(f.type);
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleExtract = async () => {
    if (!file || !selectedCompanyId) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('company_id', selectedCompanyId);

      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const response = await axios.post(`${backendUrl}/invoices/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${currentSession?.access_token}`,
        },
      });

      const batchId = response.data?.batch_id;
      if (batchId) {
        router.push(`/review?batch_id=${batchId}`);
      } else {
        setUploadError('Upload succeeded but no batch ID was returned.');
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setUploadError(err.response?.data?.detail || err.message || 'Upload failed.');
      } else {
        setUploadError('Upload failed. Please try again.');
      }
    } finally {
      setUploading(false);
    }
  };

  const canExtract = file !== null && selectedCompanyId !== '';

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar
        companies={companies}
        selectedCompanyId={selectedCompanyId}
        onCompanyChange={setSelectedCompanyId}
      />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h2 className="text-xl font-semibold text-gray-900 mb-6">Upload Invoice</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Company selector */}
          <div className="md:col-span-1">
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Company</h3>
              {companies.length === 0 ? (
                <div className="text-sm text-gray-500 italic">
                  No companies — Add one in settings
                </div>
              ) : (
                <select
                  value={selectedCompanyId}
                  onChange={(e) => setSelectedCompanyId(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="" disabled>Select a company</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Upload zone */}
          <div className="md:col-span-2">
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Invoice File</h3>

              {/* Drop zone */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  dragging
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-gray-300 hover:border-indigo-400 hover:bg-gray-50'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {file ? (
                  <div className="flex items-center justify-center gap-3">
                    <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
                      <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-medium text-gray-900">{file.name}</p>
                      <p className="text-xs text-gray-500">{formatBytes(file.size)}</p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      className="ml-2 text-gray-400 hover:text-red-500"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <div>
                    <svg className="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-sm text-gray-600">
                      <span className="text-indigo-600 font-medium">Click to upload</span> or drag & drop
                    </p>
                    <p className="text-xs text-gray-400 mt-1">PDF, JPG, JPEG, PNG</p>
                  </div>
                )}
              </div>

              {uploadError && (
                <p className="mt-2 text-sm text-red-600">{uploadError}</p>
              )}

              <button
                onClick={handleExtract}
                disabled={!canExtract || uploading}
                className="mt-4 w-full py-2.5 px-4 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {uploading ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Extracting data…
                  </>
                ) : (
                  'Extract Data'
                )}
              </button>

              {!selectedCompanyId && companies.length > 0 && (
                <p className="mt-2 text-xs text-amber-600 text-center">Select a company to enable extraction</p>
              )}
            </div>
          </div>
        </div>

        {/* Recent uploads */}
        {recentInvoices.length > 0 && (
          <div className="mt-8">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Recent Uploads</h3>
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">File</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Date</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recentInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-900 font-medium truncate max-w-xs">{inv.file_name || inv.id}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {new Date(inv.created_at).toLocaleDateString('en-IN')}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          inv.status === 'approved'
                            ? 'bg-green-100 text-green-700'
                            : inv.status === 'pending'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {inv.status || 'processed'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {inv.batch_id && (
                          <button
                            onClick={() => router.push(`/review?batch_id=${inv.batch_id}`)}
                            className="text-indigo-600 hover:underline text-xs"
                          >
                            Review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function UploadPage() {
  return <AuthGuard>{(session) => <UploadContent session={session} />}</AuthGuard>;
}
