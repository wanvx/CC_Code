package com.pocketcode.ide;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends android.app.Activity {

    private static final String START_URL =
            "https://appassets.androidplatform.net/assets/index.html";
    private static final int REQ_EXPORT = 1001;

    private WebView webView;
    private File pendingExportFile;
    private String pendingExportName;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 开启 WebView 远程调试（chrome://inspect / CDP 可连），便于真机排查渲染问题
        WebView.setWebContentsDebuggingEnabled(true);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 标记原生环境：前端据此跳过 Service Worker 注册（避免 APK 更新后命中旧缓存）
        s.setUserAgentString(s.getUserAgentString() + " PocketCodeNative");
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 导出桥：前端检测到 window.PocketCodeNative 时走系统文件选择器
        webView.addJavascriptInterface(new Bridge(), "PocketCodeNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("appassets.androidplatform.net".equals(uri.getHost())) return false;
                // 外部链接交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) { }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    // ── 导出到平板任意文件夹（SAF）──────────────
    private class Bridge {
        @JavascriptInterface
        public void exportFile(final String name, final String base64) {
            runOnUiThread(() -> doExport(name, base64));
        }

        /** 用系统浏览器打开链接（GitHub / 新版本下载） */
        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null || url.isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    android.util.Log.w("PocketCode", "openUrl failed: " + e);
                }
            });
        }
    }

    private void doExport(String name, String base64) {
        try {
            String safe = (name == null ? "" : name).replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
            if (safe.isEmpty()) safe = "main.cpp";

            byte[] data = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
            File dir = new File(getCacheDir(), "export");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("无法创建临时目录");
            File out = new File(dir, safe);
            try (FileOutputStream fo = new FileOutputStream(out)) {
                fo.write(data);
            }
            pendingExportFile = out;
            pendingExportName = safe;

            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mimeOf(safe));
            i.putExtra(Intent.EXTRA_TITLE, safe);
            startActivityForResult(i, REQ_EXPORT);
        } catch (Exception e) {
            reply(false, String.valueOf(e.getMessage()));
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".cpp") || n.endsWith(".cc") || n.endsWith(".cxx")) return "text/x-c++src";
        if (n.endsWith(".c")) return "text/x-csrc";
        if (n.endsWith(".h") || n.endsWith(".hpp") || n.endsWith(".hh")) return "text/x-chdr";
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".json")) return "application/json";
        return "text/plain";
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_EXPORT) return;

        File src = pendingExportFile;
        pendingExportFile = null;

        if (res != RESULT_OK || data == null || data.getData() == null) {
            reply(false, "已取消");
            cleanup(src);
            return;
        }
        Uri uri = data.getData();
        try (InputStream in = new FileInputStream(src);
             OutputStream out = getContentResolver().openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("无法写入目标位置");
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            reply(true, pendingExportName == null ? "" : pendingExportName);
        } catch (Exception e) {
            reply(false, String.valueOf(e.getMessage()));
        } finally {
            cleanup(src);
        }
    }

    private void cleanup(File f) {
        try { if (f != null && f.exists()) f.delete(); } catch (Exception ignored) { }
    }

    private void reply(boolean ok, String msg) {
        final String js = "window.__pcExportResult && window.__pcExportResult(" + ok + ", "
                + JSONObject.quote(msg == null ? "" : msg) + ")";
        webView.post(() -> {
            try { webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
