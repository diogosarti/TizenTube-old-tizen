#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include <nacl/nacl_random.h>
#include "ppapi/c/pp_errors.h"
#include "ppapi/cpp/core.h"
#include "ppapi/cpp/host_resolver.h"
#include "ppapi/cpp/instance.h"
#include "ppapi/cpp/module.h"
#include "ppapi/cpp/tcp_socket.h"
#include "ppapi/cpp/var_array_buffer.h"
#include "ppapi/cpp/var_array.h"
#include "ppapi/cpp/var_dictionary.h"
#include "ppapi/utility/completion_callback_factory.h"
#include "mbedtls/entropy.h"
#include "mbedtls/error.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/platform_time.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "psa/crypto.h"
#include "zlib.h"
#include "ca_roots.h"

extern "C" mbedtls_ms_time_t mbedtls_ms_time(void) {
    return static_cast<mbedtls_ms_time_t>(pp::Module::Get()->core()->GetTimeTicks() * 1000);
}
extern "C" int mbedtls_hardware_poll(void*, unsigned char* output, size_t length, size_t* written) {
    return nacl_secure_random(output, length, written) == 0 ? 0 : MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
}
static int RandomBytes(void*, unsigned char* output, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        size_t written = 0;
        if (nacl_secure_random(output + offset, length - offset, &written) != 0 || !written)
            return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
        offset += written;
    }
    return 0;
}
static std::string Lower(std::string s) {
    for (size_t i = 0; i < s.size(); ++i) s[i] = std::tolower(static_cast<unsigned char>(s[i]));
    return s;
}
static std::string Trim(const std::string& s) {
    const size_t start = s.find_first_not_of(" \t"), end = s.find_last_not_of(" \t");
    return start == std::string::npos ? "" : s.substr(start, end - start + 1);
}
static std::string Decimal(int64_t n) {
    char text[32]; snprintf(text, sizeof(text), "%lld", static_cast<long long>(n)); return text;
}
static void CompleteIfSynchronous(int32_t result, const pp::CompletionCallback& callback) {
    if (result != PP_OK_COMPLETIONPENDING) pp::Module::Get()->core()->CallOnMainThread(0, callback, result);
}
static bool Number(const std::string& s, unsigned base, uint64_t* n) {
    if (s.empty()) return false;
    *n = 0;
    for (char c : s) {
        unsigned d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 99;
        if (d >= base || *n > (UINT64_MAX - d) / base) return false;
        *n = *n * base + d;
    }
    return true;
}
class Transport;
class Request {
public:
    Request(Transport* owner, const pp::VarDictionary& message);
    ~Request();
    void Begin();
    void Finish(const std::string& error);
    pp::VarDictionary Diagnostics() const {
        pp::VarDictionary m; m.Set("id", id_); m.Set("operation", static_cast<int>(operation_));
        m.Set("received", static_cast<double>(received_)); m.Set("remaining", static_cast<double>(remaining_));
        m.Set("input", static_cast<int>(response_.size())); m.Set("output", static_cast<int>(output_.size()));
        m.Set("headers", headers_done_); m.Set("chunked", chunked_); m.Set("readPending", read_pending_); m.Set("writePending", write_pending_);
        m.Set("readCall", read_call_); m.Set("readSize", read_size_);
        return m;
    }
private:
    enum Operation { Handshake, WriteRequest, ReadResponse };
    Transport* owner_;
    pp::CompletionCallbackFactory<Request> callbacks_;
    pp::HostResolver resolver_;
    pp::TCPSocket socket_;
    mbedtls_ssl_context ssl_;
    mbedtls_ssl_config config_;
    z_stream inflater_;
    bool gzip_, gzip_done_, retryable_;
    int id_, port_;
    Operation operation_;
    bool done_, write_pending_, read_pending_, flush_scheduled_, read_ready_, headers_done_, chunked_, has_length_, chunk_end_;
    int32_t read_result_, read_call_, read_size_;
    std::vector<char> outgoing_, wire_queue_, output_;
    char incoming_[65536];
    size_t request_offset_, wire_offset_, incoming_offset_;
    uint64_t remaining_, chunk_remaining_, received_;
    int chunk_state_;
    std::string host_, method_, mode_, request_, response_;
    void Resolved(int32_t code);
    void Connected(int32_t code);
    void Written(int32_t code);
    void FlushWire(int32_t);
    void ScheduleWrite();
    void Read(int32_t code);
    void Timeout(int32_t);
    void Drive();
    void FailCode(const char* label, int code);
    void FailTls(int code);
    bool ParseResponse();
    bool ParseHeaders(const std::string& header);
    bool Body(const char* data, size_t length);
    bool Output(const char* data, size_t length);
    void Flush();
    static int Send(void* context, const unsigned char* bytes, size_t length);
    static int Receive(void* context, unsigned char* bytes, size_t length);
};
class Transport : public pp::Instance {
public:
    explicit Transport(PP_Instance instance) : pp::Instance(instance), callbacks_(this) { mbedtls_x509_crt_init(&roots_); }
    ~Transport() override { callbacks_.CancelAll(); requests_.clear(); mbedtls_x509_crt_free(&roots_); }
    bool Init(uint32_t, const char*[], const char*[]) override {
        int code = psa_crypto_init() == PSA_SUCCESS ? mbedtls_x509_crt_parse(&roots_, ca_roots, sizeof(ca_roots)) : -1;
        if (!pp::HostResolver::IsAvailable() || !pp::TCPSocket::IsAvailable()) code = -2;
        pp::VarDictionary m; m.Set("type", "ready"); m.Set("ok", code == 0); m.Set("code", code); PostMessage(m);
        return code == 0;
    }
    void HandleMessage(const pp::Var& value) override {
        if (!value.is_dictionary()) return;
        pp::VarDictionary m(value);
        if (m.Get("type").AsString() == "inspect") {
            pp::VarArray active; uint32_t i = 0;
            for (const auto& entry : requests_) active.Set(i++, entry.second->Diagnostics());
            pp::VarDictionary d; d.Set("type", "diagnostics"); d.Set("requests", active); PostMessage(d); return;
        }
        if (!m.Get("id").is_int()) return;
        const int id = m.Get("id").AsInt();
        if (m.Get("type").AsString() == "abort") {
            auto it = requests_.find(id);
            if (it != requests_.end()) it->second->Finish("abort");
        } else if (m.Get("type").AsString() == "request" && !requests_.count(id)) {
            if (requests_.size() >= 8) { pp::VarDictionary e; e.Set("type", "error"); e.Set("id", id); e.Set("error", "Connection limit"); PostMessage(e); return; }
            requests_[id].reset(new Request(this, m));
            requests_[id]->Begin();
        }
    }
    mbedtls_x509_crt* roots() { return &roots_; }
    void Retire(int id) { pp::Module::Get()->core()->CallOnMainThread(0, callbacks_.NewCallback(&Transport::Remove, id)); }
private:
    pp::CompletionCallbackFactory<Transport> callbacks_;
    mbedtls_x509_crt roots_;
    std::map<int, std::unique_ptr<Request>> requests_;
    void Remove(int32_t, int id) { requests_.erase(id); }
};
Request::Request(Transport* owner, const pp::VarDictionary& m)
    : owner_(owner), callbacks_(this), gzip_(false), gzip_done_(false), retryable_(false), id_(m.Get("id").AsInt()), port_(m.Get("port").AsInt()), operation_(Handshake),
      done_(false), write_pending_(false), read_pending_(false), flush_scheduled_(false), read_ready_(false),
      headers_done_(false), chunked_(false), has_length_(false), chunk_end_(false), read_result_(0),
      read_call_(0), read_size_(0), request_offset_(0), wire_offset_(0), incoming_offset_(0), remaining_(0), chunk_remaining_(0), received_(0), chunk_state_(0),
      host_(m.Get("host").AsString()), method_(m.Get("method").AsString()), mode_(m.Get("mode").AsString()) {
    mbedtls_ssl_init(&ssl_); mbedtls_ssl_config_init(&config_);
    memset(&inflater_, 0, sizeof(inflater_));
    std::string path = m.Get("path").AsString(), headers = m.Get("headers").AsString();
    // The bridge supplies HTTP fields, never a preformatted request line or Host.
    if (host_.empty() || host_.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-") != std::string::npos ||
        port_ < 1 || port_ > 65535 || path.empty() || path[0] != '/' || path.find_first_of("\r\n ") != std::string::npos ||
        method_.empty() || method_.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ") != std::string::npos ||
        (mode_ != "auto" && mode_ != "1.2" && mode_ != "1.3")) return;
    std::string safe_headers;
    size_t at = 0;
    while (at < headers.size()) {
        size_t end = headers.find("\r\n", at), colon = headers.find(':', at);
        if (end == std::string::npos || colon == std::string::npos || colon >= end) return;
        std::string name = headers.substr(at, colon - at), value = headers.substr(colon + 1, end - colon - 1);
        if (name.empty() || name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-.^_`|~") != std::string::npos ||
            value.find_first_of("\r\n") != std::string::npos) return;
        std::string lower = Lower(name);
        if (lower != "host" && lower != "connection" && lower != "content-length" && lower != "transfer-encoding" && lower != "accept-encoding" && lower != "expect")
            safe_headers += name + ":" + value + "\r\n";
        at = end + 2;
    }
    pp::Var body = m.Get("body");
    uint32_t length = body.is_array_buffer() ? pp::VarArrayBuffer(body).ByteLength() : 0;
    if (length > 8 * 1024 * 1024 || safe_headers.size() > 65536) return;
    request_ = method_ + " " + path + " HTTP/1.1\r\nHost: " + host_ + (port_ == 443 ? "" : ":" + Decimal(port_)) +
        "\r\nConnection: close\r\nAccept-Encoding: gzip\r\n" + safe_headers;
    if (length || method_ == "POST" || method_ == "PUT" || method_ == "PATCH") request_ += "Content-Length: " + Decimal(length) + "\r\n";
    request_ += "\r\n";
    if (length) { pp::VarArrayBuffer buffer(body); request_.append(static_cast<const char*>(buffer.Map()), length); buffer.Unmap(); }
}
Request::~Request() { callbacks_.CancelAll(); socket_.Close(); if (gzip_) inflateEnd(&inflater_); mbedtls_ssl_free(&ssl_); mbedtls_ssl_config_free(&config_); }
void Request::Begin() {
    if (request_.empty()) { Finish("Invalid HTTP request"); return; }
    pp::Module::Get()->core()->CallOnMainThread(120000, callbacks_.NewCallback(&Request::Timeout));
    resolver_ = pp::HostResolver(owner_);
    PP_HostResolver_Hint hint = { PP_NETADDRESS_FAMILY_IPV4, 0 };
    auto callback = callbacks_.NewOptionalCallback(&Request::Resolved);
    CompleteIfSynchronous(resolver_.Resolve(host_.c_str(), port_, hint, callback), callback);
}
void Request::Resolved(int32_t code) {
    if (code != PP_OK) { FailCode("DNS", code); return; }
    if (!resolver_.GetNetAddressCount()) { Finish("DNS: no IPv4 address"); return; }
    socket_ = pp::TCPSocket(owner_);
    auto callback = callbacks_.NewOptionalCallback(&Request::Connected);
    CompleteIfSynchronous(socket_.Connect(resolver_.GetNetAddress(0), callback), callback);
}
void Request::Connected(int32_t code) {
    if (code != PP_OK) { FailCode("TCP", code); return; }
    int r = mbedtls_ssl_config_defaults(&config_, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
    if (r) { FailTls(r); return; }
    mbedtls_ssl_conf_min_tls_version(&config_, mode_ == "1.3" ? MBEDTLS_SSL_VERSION_TLS1_3 : MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_max_tls_version(&config_, mode_ == "1.2" ? MBEDTLS_SSL_VERSION_TLS1_2 : MBEDTLS_SSL_VERSION_TLS1_3);
    mbedtls_ssl_conf_authmode(&config_, MBEDTLS_SSL_VERIFY_REQUIRED);
    mbedtls_ssl_conf_ca_chain(&config_, owner_->roots(), NULL);
    mbedtls_ssl_conf_rng(&config_, RandomBytes, NULL);
    r = mbedtls_ssl_setup(&ssl_, &config_);
    if (!r) r = mbedtls_ssl_set_hostname(&ssl_, host_.c_str());
    if (r) { FailTls(r); return; }
    mbedtls_ssl_set_bio(&ssl_, this, Send, Receive, NULL);
    Drive();
}
int Request::Send(void* context, const unsigned char* bytes, size_t length) {
    Request* self = static_cast<Request*>(context);
    if (self->wire_queue_.size() + self->outgoing_.size() - self->wire_offset_ + length > 256 * 1024) return MBEDTLS_ERR_SSL_WANT_WRITE;
    // Coalesce the TLS flight before handing it to Pepper, avoiding separate tiny TCP writes.
    self->wire_queue_.insert(self->wire_queue_.end(), bytes, bytes + length);
    self->ScheduleWrite();
    return static_cast<int>(length);
}
void Request::ScheduleWrite() {
    if (flush_scheduled_ || write_pending_ || done_) return;
    flush_scheduled_ = true;
    pp::Module::Get()->core()->CallOnMainThread(0, callbacks_.NewCallback(&Request::FlushWire));
}
void Request::FlushWire(int32_t) {
    flush_scheduled_ = false;
    if (done_ || write_pending_) return;
    if (wire_offset_ == outgoing_.size()) { outgoing_.clear(); outgoing_.swap(wire_queue_); wire_offset_ = 0; }
    if (outgoing_.empty()) return;
    write_pending_ = true;
    auto callback = callbacks_.NewOptionalCallback(&Request::Written);
    CompleteIfSynchronous(socket_.Write(outgoing_.data() + wire_offset_, outgoing_.size() - wire_offset_, callback), callback);
}
int Request::Receive(void* context, unsigned char* bytes, size_t length) {
    Request* self = static_cast<Request*>(context);
    if (self->read_ready_) {
        if (self->read_result_ < 0) return MBEDTLS_ERR_NET_RECV_FAILED;
        size_t count = std::min(length, static_cast<size_t>(self->read_result_) - self->incoming_offset_);
        memcpy(bytes, self->incoming_ + self->incoming_offset_, count); self->incoming_offset_ += count;
        if (self->incoming_offset_ == static_cast<size_t>(self->read_result_)) self->read_ready_ = false;
        return static_cast<int>(count);
    }
    if (!self->read_pending_) {
        if (!length) return 0;
        self->read_pending_ = true;
        // Read ahead at the TCP boundary, then serve small TLS header reads from this buffer.
        self->read_size_ = sizeof(self->incoming_);
        auto callback = self->callbacks_.NewOptionalCallback(&Request::Read);
        self->read_call_ = self->socket_.Read(self->incoming_, self->read_size_, callback);
        CompleteIfSynchronous(self->read_call_, callback);
    }
    return MBEDTLS_ERR_SSL_WANT_READ;
}
void Request::Written(int32_t code) {
    write_pending_ = false;
    if (code <= 0) { FailCode("TCP write", code); return; }
    wire_offset_ += code; ScheduleWrite(); Drive();
}
void Request::Read(int32_t code) {
    read_pending_ = false; read_ready_ = true; read_result_ = code; incoming_offset_ = 0;
    if (code < 0) { FailCode("TCP read", code); return; } Drive();
}
void Request::Timeout(int32_t) { Finish("timeout"); }
void Request::FailCode(const char* label, int code) {
    // A reset during the TLS handshake cannot have sent an HTTP request yet.
    retryable_ = operation_ == Handshake && code == PP_ERROR_FAILED && strcmp(label, "TCP read") == 0;
    Finish(std::string(label) + ": " + Decimal(code));
}
void Request::FailTls(int code) { char text[256]; mbedtls_strerror(code, text, sizeof(text)); Finish(text); }
void Request::Flush() {
    if (output_.empty()) return;
    pp::VarArrayBuffer buffer(static_cast<uint32_t>(output_.size()));
    memcpy(buffer.Map(), output_.data(), output_.size()); buffer.Unmap();
    pp::VarDictionary m; m.Set("type", "data"); m.Set("id", id_); m.Set("body", buffer); owner_->PostMessage(m); output_.clear();
}
bool Request::Body(const char* data, size_t length) {
    if (!gzip_) return Output(data, length);
    if (!length) return true;
    if (gzip_done_) { Finish("Unexpected bytes after gzip stream"); return false; }
    inflater_.next_in = reinterpret_cast<Bytef*>(const_cast<char*>(data));
    inflater_.avail_in = static_cast<uInt>(length);
    do {
        char decoded[16384];
        inflater_.next_out = reinterpret_cast<Bytef*>(decoded); inflater_.avail_out = sizeof(decoded);
        const int result = inflate(&inflater_, Z_NO_FLUSH);
        if (result != Z_OK && result != Z_STREAM_END && result != Z_BUF_ERROR) { Finish("Invalid gzip response"); return false; }
        if (!Output(decoded, sizeof(decoded) - inflater_.avail_out)) return false;
        if (result == Z_STREAM_END) {
            gzip_done_ = true;
            if (inflater_.avail_in) { Finish("Unexpected bytes after gzip stream"); return false; }
            break;
        }
        if (result == Z_BUF_ERROR && inflater_.avail_in) { Finish("Invalid gzip response"); return false; }
    } while (inflater_.avail_in || !inflater_.avail_out);
    return true;
}
bool Request::Output(const char* data, size_t length) {
    received_ += length;
    if (received_ > 64 * 1024 * 1024) { Finish("Response exceeds 64 MiB; use media ranges"); return false; }
    output_.insert(output_.end(), data, data + length);
    if (output_.size() >= 32768) Flush();
    return true;
}
void Request::Finish(const std::string& error) {
    if (done_) return;
    const std::string final_error = error.empty() && gzip_ && !gzip_done_ ? "Truncated gzip response" : error;
    done_ = true; callbacks_.CancelAll(); socket_.Close();
    if (final_error.empty()) Flush();
    pp::VarDictionary m; m.Set("type", final_error.empty() ? "done" : "error"); m.Set("id", id_);
    if (!final_error.empty()) m.Set("error", final_error);
    if (!final_error.empty()) m.Set("retryable", retryable_);
    owner_->PostMessage(m); owner_->Retire(id_);
}
bool Request::ParseHeaders(const std::string& h) {
    size_t end = h.find("\r\n");
    if (end == std::string::npos || end < 12 || (h.compare(0, 9, "HTTP/1.1 ") && h.compare(0, 9, "HTTP/1.0 "))) { Finish("Invalid HTTP status line"); return false; }
    uint64_t status;
    if (!Number(h.substr(9, 3), 10, &status) || status < 100 || status > 599) { Finish("Invalid HTTP status"); return false; }
    if (status >= 100 && status < 200 && status != 101) return true;
    if (status == 101) { Finish("HTTP upgrade unsupported"); return false; }
    std::string encoding, transfer;
    std::vector<std::pair<std::string, std::string>> fields;
    size_t at = end + 2;
    while (at < h.size()) {
        end = h.find("\r\n", at);
        size_t colon = h.find(':', at);
        if (end == std::string::npos || colon == std::string::npos || colon >= end) { Finish("Invalid HTTP header"); return false; }
        std::string name = Lower(h.substr(at, colon - at)), value = Trim(h.substr(colon + 1, end - colon - 1));
        fields.push_back(std::make_pair(name, value));
        if (name == "content-length") {
            uint64_t n;
            if (!Number(value, 10, &n) || (has_length_ && n != remaining_)) { Finish("Invalid Content-Length"); return false; }
            has_length_ = true; remaining_ = n;
        } else if (name == "transfer-encoding") transfer = Lower(value);
        else if (name == "content-encoding") encoding = Lower(value);
        at = end + 2;
    }
    if (!encoding.empty() && encoding != "identity" && encoding != "gzip") { Finish("Unsupported HTTP content encoding"); return false; }
    if (!transfer.empty() && transfer != "chunked") { Finish("Unsupported HTTP transfer encoding"); return false; }
    chunked_ = transfer == "chunked"; headers_done_ = true;
    const bool empty = method_ == "HEAD" || status == 204 || status == 304 || (!chunked_ && has_length_ && !remaining_);
    if (encoding == "gzip" && !empty) {
        if (inflateInit2(&inflater_, 16 + MAX_WBITS) != Z_OK) { Finish("Gzip initialization failed"); return false; }
        gzip_ = true;
    }
    std::string exposed_headers;
    for (const auto& field : fields) {
        // The bridge receives decoded bytes; an encoded length is not their length.
        if (gzip_ && (field.first == "content-encoding" || field.first == "content-length")) continue;
        exposed_headers += field.first + ": " + field.second + "\r\n";
    }
    pp::VarDictionary m; m.Set("type", "headers"); m.Set("id", id_); m.Set("status", static_cast<int>(status));
    m.Set("statusText", Trim(h.substr(12, h.find("\r\n") - 12)));
    m.Set("headers", exposed_headers); owner_->PostMessage(m);
    if (empty) { Finish(""); return false; }
    return true;
}
bool Request::ParseResponse() {
    if (!headers_done_) {
        size_t end = response_.find("\r\n\r\n");
        if (end == std::string::npos) {
            if (response_.size() > 65536) { Finish("HTTP headers exceed limit"); return false; } return true;
        }
        if (end > 65536) { Finish("HTTP headers exceed limit"); return false; }
        std::string h = response_.substr(0, end + 2); response_.erase(0, end + 4);
        if (!ParseHeaders(h)) return false;
        if (!headers_done_) return ParseResponse();
    }
    if (!chunked_) {
        size_t n = has_length_ ? std::min<uint64_t>(response_.size(), remaining_) : response_.size();
        if (!Body(response_.data(), n)) return false;
        response_.erase(0, n);
        if (has_length_) { remaining_ -= n; if (!remaining_) { Finish(""); return false; } }
        return true;
    }
    for (;;) {
        if (chunk_state_ == 0) {
            size_t end = response_.find("\r\n");
            if (end == std::string::npos) {
                if (response_.size() > 8192) { Finish("Chunk line exceeds limit"); return false; } return true;
            }
            std::string size = response_.substr(0, end); size = size.substr(0, size.find(';'));
            if (!Number(size, 16, &chunk_remaining_)) { Finish("Invalid chunk size"); return false; }
            response_.erase(0, end + 2); chunk_state_ = chunk_remaining_ ? 1 : 3;
        } else if (chunk_state_ == 1) {
            size_t n = std::min<uint64_t>(response_.size(), chunk_remaining_);
            if (!Body(response_.data(), n)) return false;
            response_.erase(0, n); chunk_remaining_ -= n;
            if (chunk_remaining_) return true;
            chunk_state_ = 2;
        } else if (chunk_state_ == 2) {
            if (response_.size() < 2) return true;
            if (response_.compare(0, 2, "\r\n")) { Finish("Invalid chunk terminator"); return false; }
            response_.erase(0, 2); chunk_state_ = 0;
        } else {
            if (response_.compare(0, 2, "\r\n") == 0 || response_.find("\r\n\r\n") != std::string::npos) { chunk_end_ = true; Finish(""); return false; }
            if (response_.size() > 65536) { Finish("HTTP trailers exceed limit"); return false; } return true;
        }
    }
}
void Request::Drive() {
    while (!done_) {
        int r;
        if (operation_ == Handshake) {
            r = mbedtls_ssl_handshake(&ssl_);
            if (!r) {
                pp::VarDictionary m; m.Set("type", "tls"); m.Set("id", id_); m.Set("tls", mbedtls_ssl_get_version(&ssl_));
                m.Set("verified", mbedtls_ssl_get_verify_result(&ssl_) == 0); owner_->PostMessage(m);
                operation_ = WriteRequest; continue;
            }
        } else if (operation_ == WriteRequest) {
            r = mbedtls_ssl_write(&ssl_, reinterpret_cast<const unsigned char*>(request_.data() + request_offset_),
                                 std::min<size_t>(16384, request_.size() - request_offset_));
            if (r > 0) { request_offset_ += r; if (request_offset_ == request_.size()) { request_.clear(); operation_ = ReadResponse; } continue; }
        } else {
            unsigned char buffer[16384]; r = mbedtls_ssl_read(&ssl_, buffer, sizeof(buffer));
            if (r > 0) { response_.append(reinterpret_cast<char*>(buffer), r); if (!ParseResponse()) return; continue; }
            if (!r || r == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) {
                Finish(!headers_done_ || (chunked_ && !chunk_end_) || (has_length_ && remaining_) ? "Truncated HTTP response" : ""); return;
            }
        }
        if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return;
        FailTls(r); return;
    }
}
class TransportModule : public pp::Module {
    pp::Instance* CreateInstance(PP_Instance instance) override { return new Transport(instance); }
};
namespace pp { Module* CreateModule() { return new TransportModule(); } }
