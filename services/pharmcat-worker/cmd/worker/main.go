package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"hash/crc32"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	maxInputBytes         int64 = 512 * 1024 * 1024
	maxUncompressedBytes  int64 = 2 * 1024 * 1024 * 1024
	maxOutputBytes        int64 = 16 * 1024 * 1024
	maxVCFRecords               = 10_000_000
	maxVCFLineBytes             = 16 * 1024 * 1024
	metadataTokenTimeout        = 30 * time.Second
	controlRequestTimeout       = 2 * time.Minute
	downloadIdleTimeout         = 90 * time.Second
	maxDownloadAttempts         = 4
)

var (
	runIDPattern  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	tenantPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$`)
	imagePattern  = regexp.MustCompile(`^pgkb/pharmcat:([0-9]+\.[0-9]+\.[0-9]+)@sha256:([0-9a-f]{64})$`)
	digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	grch38Token   = regexp.MustCompile(`(?i)(^|[^a-z0-9])(grch38(?:\.p[0-9]+)?|hg38|b38)([^a-z0-9]|$)`)
	grch37Token   = regexp.MustCompile(`(?i)(^|[^a-z0-9])(grch37(?:\.p[0-9]+)?|hg19|b37)([^a-z0-9]|$)`)
	calledGTToken = regexp.MustCompile(`^[0-9]+(?:[|/][0-9]+)*$`)
	contentRange  = regexp.MustCompile(`^bytes ([0-9]+)-([0-9]+)/([0-9]+)$`)
	crc32cTable   = crc32.MakeTable(crc32.Castagnoli)
)

var pharmCATArguments = []string{"input.vcf", "-o", "output", "-reporterJson", "-reporterCallsOnlyTsv"}

type workerError struct {
	code    string
	message string
	cause   error
}

func (e *workerError) Error() string {
	if e.cause == nil {
		return e.code
	}
	return e.code + ": " + e.cause.Error()
}

type config struct {
	runID          string
	tenantID       string
	bucket         string
	image          string
	imageDigest    string
	workerDigest   string
	execution      string
	commandTimeout time.Duration
}

type objectMetadata struct {
	Generation  string `json:"generation"`
	Size        string `json:"size"`
	ContentType string `json:"contentType"`
	CRC32C      string `json:"crc32c"`
	MD5Hash     string `json:"md5Hash"`
}

type storedJSON struct {
	Value      map[string]any
	Generation string
	Bytes      []byte
}

type googleClient struct {
	httpClient              *http.Client
	accessToken             string
	downloadIdleTimeout     time.Duration
	maxDownloadAttempts     int
	waitBeforeDownloadRetry func(context.Context, int) error
}

type objectIntegrity struct {
	size    int64
	crc32c  []byte
	md5Hash []byte
}

type inputAudit struct {
	Format                string
	SizeBytes             int64
	SHA256                string
	ObjectGeneration      string
	GenomeBuild           string
	SampleCount           int
	RecordCount           int
	UncompressedSizeBytes int64
}

type geneCoverage struct {
	Status                string   `json:"status"`
	PositionsCalled       int      `json:"positionsCalled"`
	PositionsMissing      int      `json:"positionsMissing"`
	MissingPositionLabels []string `json:"missingPositionLabels"`
}

type coverageDocument struct {
	SchemaVersion string                  `json:"schemaVersion"`
	RunID         string                  `json:"runId"`
	Genes         map[string]geneCoverage `json:"genes"`
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func readConfig() (config, error) {
	runID, err := requiredEnv("PGX_RUN_ID")
	if err != nil {
		return config{}, err
	}
	tenantID, err := requiredEnv("PGX_TENANT_ID")
	if err != nil {
		return config{}, err
	}
	bucket, err := requiredEnv("PHARMCAT_RUN_BUCKET")
	if err != nil {
		return config{}, err
	}
	image, err := requiredEnv("PHARMCAT_IMAGE")
	if err != nil {
		return config{}, err
	}
	execution, err := requiredEnv("CLOUD_RUN_EXECUTION")
	if err != nil {
		return config{}, err
	}
	workerDigest, err := requiredEnv("PGX_WORKER_IMAGE_DIGEST")
	if err != nil {
		return config{}, err
	}
	taskAttempt := strings.TrimSpace(os.Getenv("CLOUD_RUN_TASK_ATTEMPT"))
	if taskAttempt == "" {
		taskAttempt = "0"
	}
	match := imagePattern.FindStringSubmatch(image)
	if !runIDPattern.MatchString(runID) || !tenantPattern.MatchString(tenantID) || !bucketPattern.MatchString(bucket) || match == nil || !digestPattern.MatchString(workerDigest) {
		return config{}, errors.New("worker configuration is invalid")
	}
	if taskAttempt != "0" {
		return config{}, errors.New("automatic task retries are disabled for sealed PharmCAT runs")
	}
	return config{
		runID:          runID,
		tenantID:       tenantID,
		bucket:         bucket,
		image:          image,
		imageDigest:    "sha256:" + match[2],
		workerDigest:   workerDigest,
		execution:      execution,
		commandTimeout: 15 * time.Minute,
	}, nil
}

func metadataToken(client *http.Client) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), metadataTokenTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Metadata-Flavor", "Google")
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata token status %d", response.StatusCode)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&payload); err != nil || payload.AccessToken == "" {
		return "", errors.New("invalid metadata token response")
	}
	return payload.AccessToken, nil
}

func newGoogleHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	transport.ExpectContinueTimeout = time.Second
	transport.IdleConnTimeout = 90 * time.Second
	return &http.Client{Transport: transport}
}

func newGoogleClient() (*googleClient, error) {
	client := newGoogleHTTPClient()
	token, err := metadataToken(client)
	if err != nil {
		return nil, err
	}
	return &googleClient{
		httpClient:          client,
		accessToken:         token,
		downloadIdleTimeout: downloadIdleTimeout,
		maxDownloadAttempts: maxDownloadAttempts,
	}, nil
}

func (g *googleClient) request(ctx context.Context, method string, target *url.URL, body io.Reader, contentType string) (*http.Response, error) {
	return g.requestWithHeaders(ctx, method, target, body, contentType, nil)
}

func (g *googleClient) requestWithHeaders(ctx context.Context, method string, target *url.URL, body io.Reader, contentType string, headers http.Header) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+g.accessToken)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	return g.httpClient.Do(request)
}

func storageObjectURL(bucket, object string, query map[string]string) *url.URL {
	path := "/storage/v1/b/" + bucket + "/o/" + object
	rawPath := "/storage/v1/b/" + url.PathEscape(bucket) + "/o/" + url.PathEscape(object)
	target := &url.URL{
		Scheme:  "https",
		Host:    "storage.googleapis.com",
		Path:    path,
		RawPath: rawPath,
	}
	values := target.Query()
	for key, value := range query {
		values.Set(key, value)
	}
	target.RawQuery = values.Encode()
	return target
}

func storageUploadURL(bucket, object, generation string) *url.URL {
	target := &url.URL{
		Scheme: "https",
		Host:   "storage.googleapis.com",
		Path:   "/upload/storage/v1/b/" + url.PathEscape(bucket) + "/o",
	}
	values := target.Query()
	values.Set("uploadType", "media")
	values.Set("name", object)
	values.Set("ifGenerationMatch", generation)
	target.RawQuery = values.Encode()
	return target
}

func (g *googleClient) metadata(ctx context.Context, bucket, object string) (*objectMetadata, error) {
	operationContext, cancel := context.WithTimeout(ctx, controlRequestTimeout)
	defer cancel()
	response, err := g.request(operationContext, http.MethodGet, storageObjectURL(bucket, object, nil), nil, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, os.ErrNotExist
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("metadata read status %d", response.StatusCode)
	}
	var result objectMetadata
	if err := json.NewDecoder(io.LimitReader(response.Body, 128*1024)).Decode(&result); err != nil || result.Generation == "" || result.Size == "" {
		return nil, errors.New("invalid object metadata")
	}
	return &result, nil
}

func objectIntegrityFromMetadata(metadata *objectMetadata, maxBytes int64) (*objectIntegrity, error) {
	if metadata == nil || metadata.Generation == "" || metadata.Size == "" {
		return nil, errors.New("object metadata is incomplete")
	}
	generation, err := strconv.ParseUint(metadata.Generation, 10, 64)
	if err != nil || generation == 0 {
		return nil, errors.New("object generation is invalid")
	}
	size, err := strconv.ParseInt(metadata.Size, 10, 64)
	if err != nil || size < 0 {
		return nil, errors.New("object size is invalid")
	}
	if maxBytes < 0 || size > maxBytes {
		return nil, errors.New("object exceeds size limit")
	}
	result := &objectIntegrity{size: size}
	if metadata.CRC32C != "" {
		result.crc32c, err = base64.StdEncoding.Strict().DecodeString(metadata.CRC32C)
		if err != nil || len(result.crc32c) != crc32.Size {
			return nil, errors.New("object CRC32C metadata is invalid")
		}
	}
	if metadata.MD5Hash != "" {
		result.md5Hash, err = base64.StdEncoding.Strict().DecodeString(metadata.MD5Hash)
		if err != nil || len(result.md5Hash) != md5.Size {
			return nil, errors.New("object MD5 metadata is invalid")
		}
	}
	if len(result.crc32c) == 0 && len(result.md5Hash) == 0 {
		return nil, errors.New("object metadata has no authoritative checksum")
	}
	return result, nil
}

func retryableDownloadStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout,
		http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func retryableDownloadError(err error) bool {
	if err == nil {
		return false
	}
	var requestError *url.Error
	if errors.As(err, &requestError) {
		err = requestError.Err
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func validateDownloadResponse(response *http.Response, generation string, offset, total int64) error {
	if responseGeneration := response.Header.Get("x-goog-generation"); responseGeneration != "" && responseGeneration != generation {
		return errors.New("object response generation does not match metadata")
	}
	remaining := total - offset
	if remaining < 0 {
		return errors.New("object response offset exceeds metadata size")
	}
	if response.ContentLength >= 0 && response.ContentLength != remaining {
		return fmt.Errorf("object response length %d does not match expected length %d", response.ContentLength, remaining)
	}
	if offset == 0 {
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("object read status %d", response.StatusCode)
		}
		if response.Header.Get("Content-Range") != "" {
			return errors.New("initial object response unexpectedly contains a content range")
		}
		return nil
	}
	if response.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("resumed object read status %d", response.StatusCode)
	}
	matches := contentRange.FindStringSubmatch(response.Header.Get("Content-Range"))
	if matches == nil {
		return errors.New("resumed object response has an invalid content range")
	}
	start, startErr := strconv.ParseInt(matches[1], 10, 64)
	end, endErr := strconv.ParseInt(matches[2], 10, 64)
	responseTotal, totalErr := strconv.ParseInt(matches[3], 10, 64)
	if startErr != nil || endErr != nil || totalErr != nil || start != offset || end != total-1 || responseTotal != total || end < start {
		return errors.New("resumed object response content range does not match metadata")
	}
	return nil
}

func writeDownloadedBytes(destination *os.File, digests []hash.Hash, value []byte) error {
	written, err := destination.Write(value)
	if err != nil {
		return err
	}
	if written != len(value) {
		return io.ErrShortWrite
	}
	for _, digest := range digests {
		if digestWritten, digestErr := digest.Write(value); digestErr != nil || digestWritten != len(value) {
			return errors.Join(digestErr, io.ErrShortWrite)
		}
	}
	return nil
}

func readDownloadBody(response *http.Response, destination *os.File, digests []hash.Hash, timer *time.Timer, idleExpired func() bool, idleTimeout time.Duration, offset, total int64) (int64, error, error) {
	buffer := make([]byte, 64*1024)
	written := offset
	for {
		remaining := total - written
		readSize := len(buffer)
		if remaining < int64(readSize) {
			readSize = int(remaining + 1)
		}
		count, readErr := response.Body.Read(buffer[:readSize])
		if count > 0 {
			if int64(count) > remaining {
				return written, nil, errors.New("object response exceeds metadata size")
			}
			if err := writeDownloadedBytes(destination, digests, buffer[:count]); err != nil {
				return written, nil, fmt.Errorf("write downloaded object: %w", err)
			}
			written += int64(count)
			if !idleExpired() {
				timer.Reset(idleTimeout)
			}
		}
		if readErr == nil {
			continue
		}
		if errors.Is(readErr, io.EOF) {
			if written == total {
				return written, nil, nil
			}
			return written, io.ErrUnexpectedEOF, nil
		}
		if written == total {
			return written, nil, nil
		}
		return written, readErr, nil
	}
}

func (g *googleClient) downloadAttemptLimit() int {
	if g.maxDownloadAttempts > 0 {
		return g.maxDownloadAttempts
	}
	return maxDownloadAttempts
}

func (g *googleClient) downloadInactivityLimit() time.Duration {
	if g.downloadIdleTimeout > 0 {
		return g.downloadIdleTimeout
	}
	return downloadIdleTimeout
}

func defaultDownloadRetryWait(ctx context.Context, retry int) error {
	delay := 250 * time.Millisecond
	for count := 1; count < retry && delay < 2*time.Second; count++ {
		delay *= 2
	}
	if delay > 2*time.Second {
		delay = 2 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (g *googleClient) waitForDownloadRetry(ctx context.Context, retry int) error {
	if g.waitBeforeDownloadRetry != nil {
		return g.waitBeforeDownloadRetry(ctx, retry)
	}
	return defaultDownloadRetryWait(ctx, retry)
}

func (g *googleClient) download(ctx context.Context, bucket, object string, metadata *objectMetadata, destination *os.File, maxBytes int64) (int64, string, error) {
	integrity, err := objectIntegrityFromMetadata(metadata, maxBytes)
	if err != nil {
		return 0, "", err
	}
	target := storageObjectURL(bucket, object, map[string]string{
		"alt":               "media",
		"generation":        metadata.Generation,
		"ifGenerationMatch": metadata.Generation,
	})
	sha256Hash := sha256.New()
	crc32cHash := crc32.New(crc32cTable)
	md5Hash := md5.New() // Used only to verify Cloud Storage's object-integrity metadata.
	digests := []hash.Hash{sha256Hash, crc32cHash, md5Hash}
	written := int64(0)
	attemptLimit := g.downloadAttemptLimit()
	idleTimeout := g.downloadInactivityLimit()
	var lastErr error

	for attempt := 0; attempt < attemptLimit; attempt++ {
		if err := ctx.Err(); err != nil {
			return written, "", err
		}
		if attempt > 0 {
			if err := g.waitForDownloadRetry(ctx, attempt); err != nil {
				return written, "", err
			}
		}
		headers := make(http.Header)
		headers.Set("Accept-Encoding", "identity")
		if written > 0 {
			headers.Set("Range", fmt.Sprintf("bytes=%d-", written))
		}
		attemptContext, cancelAttempt := context.WithCancel(ctx)
		response, requestErr := g.requestWithHeaders(attemptContext, http.MethodGet, target, nil, "", headers)
		if requestErr != nil {
			cancelAttempt()
			if err := ctx.Err(); err != nil {
				return written, "", err
			}
			if !retryableDownloadError(requestErr) {
				return written, "", requestErr
			}
			lastErr = requestErr
			continue
		}
		if retryableDownloadStatus(response.StatusCode) {
			response.Body.Close()
			cancelAttempt()
			lastErr = fmt.Errorf("object read status %d", response.StatusCode)
			continue
		}
		if err := validateDownloadResponse(response, metadata.Generation, written, integrity.size); err != nil {
			response.Body.Close()
			cancelAttempt()
			return written, "", err
		}

		var idleTimedOut atomic.Bool
		idleTimer := time.AfterFunc(idleTimeout, func() {
			idleTimedOut.Store(true)
			cancelAttempt()
			response.Body.Close()
		})
		readBytes, retryableErr, fatalErr := readDownloadBody(response, destination, digests, idleTimer, func() bool {
			return idleTimedOut.Load()
		}, idleTimeout, written, integrity.size)
		written = readBytes
		idleTimer.Stop()
		response.Body.Close()
		cancelAttempt()
		if fatalErr != nil {
			return written, "", fatalErr
		}
		if retryableErr != nil {
			if err := ctx.Err(); err != nil {
				return written, "", err
			}
			if idleTimedOut.Load() {
				lastErr = errors.New("object download made no progress before its idle deadline")
				continue
			}
			if !retryableDownloadError(retryableErr) {
				return written, "", retryableErr
			}
			lastErr = retryableErr
			continue
		}
		lastErr = nil
		break
	}
	if lastErr != nil || written != integrity.size {
		if lastErr == nil {
			lastErr = io.ErrUnexpectedEOF
		}
		return written, "", fmt.Errorf("object download failed after %d attempts: %w", attemptLimit, lastErr)
	}
	if len(integrity.crc32c) > 0 && !bytes.Equal(crc32cHash.Sum(nil), integrity.crc32c) {
		return written, "", errors.New("object CRC32C checksum does not match metadata")
	}
	if len(integrity.md5Hash) > 0 && !bytes.Equal(md5Hash.Sum(nil), integrity.md5Hash) {
		return written, "", errors.New("object MD5 checksum does not match metadata")
	}
	return written, hex.EncodeToString(sha256Hash.Sum(nil)), nil
}

func (g *googleClient) uploadBytes(ctx context.Context, bucket, object string, bytes []byte, contentType, generation string) (string, error) {
	operationContext, cancel := context.WithTimeout(ctx, controlRequestTimeout)
	defer cancel()
	response, err := g.request(operationContext, http.MethodPost, storageUploadURL(bucket, object, generation), strings.NewReader(string(bytes)), contentType)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("object write status %d", response.StatusCode)
	}
	var metadata objectMetadata
	if err := json.NewDecoder(io.LimitReader(response.Body, 128*1024)).Decode(&metadata); err != nil || metadata.Generation == "" {
		return "", errors.New("invalid object write response")
	}
	return metadata.Generation, nil
}

func (g *googleClient) getJSON(ctx context.Context, bucket, object string, maxBytes int64) (*storedJSON, error) {
	metadata, err := g.metadata(ctx, bucket, object)
	if err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp("", "pgx-json-*")
	if err != nil {
		return nil, err
	}
	path := temporary.Name()
	defer os.Remove(path)
	defer temporary.Close()
	size, _, err := g.download(ctx, bucket, object, metadata, temporary, maxBytes)
	if err != nil {
		return nil, err
	}
	if _, err := temporary.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	bytes, err := io.ReadAll(io.LimitReader(temporary, size+1))
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(bytes, &value); err != nil {
		return nil, err
	}
	return &storedJSON{Value: value, Generation: metadata.Generation, Bytes: bytes}, nil
}

func stateObject(cfg config) string {
	return fmt.Sprintf("runs/%s/%s/state.json", cfg.tenantID, cfg.runID)
}

func inputObject(cfg config) string {
	return fmt.Sprintf("runs/%s/%s/input/source", cfg.tenantID, cfg.runID)
}

func runObject(cfg config, suffix string) string {
	return fmt.Sprintf("runs/%s/%s/%s", cfg.tenantID, cfg.runID, suffix)
}

func valueString(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

func valueInt64(record map[string]any, key string) (int64, bool) {
	value, ok := record[key].(float64)
	if !ok || value < 0 || value != float64(int64(value)) {
		return 0, false
	}
	return int64(value), true
}

func inputRecord(state map[string]any) (map[string]any, error) {
	input, ok := state["input"].(map[string]any)
	if !ok {
		return nil, errors.New("run input is invalid")
	}
	return input, nil
}

func marshal(value any) ([]byte, error) {
	return json.Marshal(value)
}

func updateState(ctx context.Context, client *googleClient, cfg config, loaded *storedJSON, status string, extra map[string]any) (*storedJSON, error) {
	next := make(map[string]any, len(loaded.Value)+len(extra)+2)
	for key, value := range loaded.Value {
		next[key] = value
	}
	next["status"] = status
	next["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	for key, value := range extra {
		next[key] = value
	}
	bytes, err := marshal(next)
	if err != nil {
		return nil, err
	}
	generation, err := client.uploadBytes(ctx, cfg.bucket, stateObject(cfg), bytes, "application/json", loaded.Generation)
	if err != nil {
		return nil, err
	}
	return &storedJSON{Value: next, Generation: generation, Bytes: bytes}, nil
}

func appendEvent(ctx context.Context, client *googleClient, cfg config, event string, details map[string]any) error {
	value := map[string]any{
		"schemaVersion": "1.0",
		"runId":         cfg.runID,
		"event":         event,
		"at":            time.Now().UTC().Format(time.RFC3339Nano),
	}
	for key, item := range details {
		value[key] = item
	}
	bytes, err := marshal(value)
	if err != nil {
		return err
	}
	name := runObject(cfg, fmt.Sprintf("events/%d-%s.json", time.Now().UTC().UnixNano(), event))
	_, err = client.uploadBytes(ctx, cfg.bucket, name, bytes, "application/json", "0")
	return err
}

func failRun(ctx context.Context, client *googleClient, cfg config, code, message string) {
	loaded, err := client.getJSON(ctx, cfg.bucket, stateObject(cfg), 128*1024)
	if err != nil {
		return
	}
	status := valueString(loaded.Value, "status")
	if status == "complete" || status == "failed" || status == "expired" {
		return
	}
	_, err = updateState(ctx, client, cfg, loaded, "failed", map[string]any{
		"error": map[string]any{"code": code, "message": message},
	})
	if err == nil {
		_ = appendEvent(ctx, client, cfg, "failed", map[string]any{"code": code})
	}
}

func copyGzip(sourcePath, destinationPath string) (int64, error) {
	source, err := os.Open(sourcePath)
	if err != nil {
		return 0, err
	}
	defer source.Close()
	compressed := bufio.NewReader(source)
	reader, err := gzip.NewReader(compressed)
	if err != nil {
		return 0, err
	}
	defer reader.Close()
	destination, err := os.OpenFile(destinationPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return 0, err
	}
	defer destination.Close()
	limited := &io.LimitedReader{R: reader, N: maxUncompressedBytes + 1}
	written, err := io.Copy(destination, limited)
	if err != nil {
		return 0, err
	}
	if written > maxUncompressedBytes {
		return 0, errors.New("uncompressed input exceeds size limit")
	}
	if err := reader.Close(); err != nil {
		return 0, err
	}
	return written, nil
}

var grch38Lengths = map[string]string{
	"1": "248956422", "2": "242193529", "3": "198295559", "X": "156040895", "Y": "57227415",
}

func normalizedChromosome(value string) string {
	value = strings.TrimPrefix(value, "chr")
	return strings.ToUpper(value)
}

func parseContig(line string) (string, string, string, bool) {
	if !strings.HasPrefix(line, "##contig=<") || !strings.HasSuffix(line, ">") {
		return "", "", "", false
	}
	fields := strings.Split(strings.TrimSuffix(strings.TrimPrefix(line, "##contig=<"), ">"), ",")
	values := map[string]string{}
	for _, field := range fields {
		parts := strings.SplitN(field, "=", 2)
		if len(parts) == 2 {
			values[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	if values["ID"] == "" {
		return "", "", "", false
	}
	return normalizedChromosome(values["ID"]), values["length"], values["assembly"], true
}

func isCalledGenotype(value string) bool {
	return calledGTToken.MatchString(value)
}

func calledGenotypeFromRow(fields []string) bool {
	if len(fields) != 10 {
		return false
	}
	format := strings.Split(fields[8], ":")
	sample := strings.Split(fields[9], ":")
	gtIndex := -1
	for index, key := range format {
		if key != "GT" {
			continue
		}
		if gtIndex != -1 {
			return false
		}
		gtIndex = index
	}
	return gtIndex >= 0 && gtIndex < len(sample) && isCalledGenotype(sample[gtIndex])
}

func validateVCF(path string) (recordCount int, sampleCount int, err error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), maxVCFLineBytes)
	hasFileFormat := false
	headerFound := false
	hasCalledGT := false
	referenceGRCh38 := false
	referenceGRCh37 := false
	contigMatches := map[string]struct{}{}
	contigMismatch := false
	assemblyGRCh38 := map[string]struct{}{}
	for scanner.Scan() {
		line := scanner.Text()
		lower := strings.ToLower(line)
		if strings.HasPrefix(line, "##fileformat=VCFv") {
			hasFileFormat = true
		}
		if strings.HasPrefix(lower, "##reference=") {
			reference := strings.TrimSpace(strings.TrimPrefix(line, "##reference="))
			if grch38Token.MatchString(reference) {
				referenceGRCh38 = true
			}
			if grch37Token.MatchString(reference) {
				referenceGRCh37 = true
			}
		}
		if chromosome, length, assembly, ok := parseContig(line); ok {
			expected, canonical := grch38Lengths[chromosome]
			if canonical && grch38Token.MatchString(assembly) {
				assemblyGRCh38[chromosome] = struct{}{}
			}
			if canonical && grch37Token.MatchString(assembly) {
				referenceGRCh37 = true
			}
			if canonical && length != "" {
				if length == expected {
					contigMatches[chromosome] = struct{}{}
				} else {
					contigMismatch = true
				}
			}
		}
		if strings.HasPrefix(line, "#CHROM\t") {
			if headerFound {
				return 0, 0, errors.New("multiple VCF column headers")
			}
			fields := strings.Split(line, "\t")
			expected := []string{"#CHROM", "POS", "ID", "REF", "ALT", "QUAL", "FILTER", "INFO", "FORMAT"}
			if len(fields) != 10 {
				return 0, 0, errors.New("VCF must contain exactly one sample")
			}
			for index, value := range expected {
				if fields[index] != value {
					return 0, 0, errors.New("VCF column header is invalid")
				}
			}
			headerFound = true
			sampleCount = 1
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !headerFound {
			return 0, 0, errors.New("VCF data appeared before its column header")
		}
		fields := strings.Split(line, "\t")
		if len(fields) != 10 || fields[2] == "" || fields[3] == "" || fields[4] == "" {
			return 0, 0, errors.New("VCF data row is invalid")
		}
		position, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || position <= 0 {
			return 0, 0, errors.New("VCF position is invalid")
		}
		format := strings.Split(fields[8], ":")
		genotype := strings.Split(fields[9], ":")
		if len(genotype) > len(format) {
			return 0, 0, errors.New("VCF FORMAT and sample values do not align")
		}
		if calledGenotypeFromRow(fields) {
			hasCalledGT = true
		}
		recordCount++
		if recordCount > maxVCFRecords {
			return 0, 0, errors.New("VCF record limit exceeded")
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if !hasFileFormat || !headerFound || !hasCalledGT || recordCount == 0 {
		return 0, 0, errors.New("VCF is incomplete")
	}
	if referenceGRCh37 || contigMismatch || (!referenceGRCh38 && len(assemblyGRCh38) < 3 && len(contigMatches) < 3) {
		return 0, 0, errors.New("GRCh38 could not be established from the VCF header")
	}
	return recordCount, sampleCount, nil
}

func findExactlyOne(root string, patterns ...string) (string, error) {
	var matches []string
	for _, pattern := range patterns {
		found, err := filepath.Glob(filepath.Join(root, pattern))
		if err != nil {
			return "", err
		}
		matches = append(matches, found...)
	}
	unique := map[string]struct{}{}
	for _, match := range matches {
		unique[match] = struct{}{}
	}
	matches = matches[:0]
	for match := range unique {
		matches = append(matches, match)
	}
	sort.Strings(matches)
	if len(matches) != 1 {
		return "", fmt.Errorf("expected one output for %v, found %d", patterns, len(matches))
	}
	return matches[0], nil
}

func readLimited(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(bytes)) > maxBytes {
		return nil, errors.New("output exceeds size limit")
	}
	return bytes, nil
}

func sha256Hex(bytes []byte) string {
	hash := sha256.Sum256(bytes)
	return hex.EncodeToString(hash[:])
}

func annotationUsesGene(annotation map[string]any, gene string) bool {
	genotypes, _ := annotation["genotypes"].([]any)
	for _, rawGenotype := range genotypes {
		genotype, _ := rawGenotype.(map[string]any)
		diplotypes, _ := genotype["diplotypes"].([]any)
		for _, rawDiplotype := range diplotypes {
			diplotype, _ := rawDiplotype.(map[string]any)
			if valueString(diplotype, "gene") == gene {
				return true
			}
		}
	}
	return false
}

func restrictReporter(original map[string]any) (map[string]any, error) {
	restricted := make(map[string]any, len(original))
	for key, value := range original {
		restricted[key] = value
	}
	genes, ok := original["genes"].(map[string]any)
	if !ok {
		return nil, errors.New("reporter genes are invalid")
	}
	restrictedGenes := map[string]any{}
	for _, gene := range []string{"CYP2C19", "CYP2B6"} {
		if value, exists := genes[gene]; exists {
			restrictedGenes[gene] = value
		}
	}
	if len(restrictedGenes) == 0 {
		return nil, errors.New("reporter has no supported non-CYP2D6 gene")
	}
	restricted["genes"] = restrictedGenes

	drugs, ok := original["drugs"].(map[string]any)
	if !ok {
		return nil, errors.New("reporter drugs are invalid")
	}
	cpic, ok := drugs["CPIC Guideline Annotation"].(map[string]any)
	if !ok {
		return nil, errors.New("reporter CPIC annotations are invalid")
	}
	restrictedCPIC := map[string]any{}
	for drugName, rawDrug := range cpic {
		drug, ok := rawDrug.(map[string]any)
		if !ok {
			continue
		}
		guidelines, _ := drug["guidelines"].([]any)
		keptGuidelines := make([]any, 0, len(guidelines))
		for _, rawGuideline := range guidelines {
			guideline, ok := rawGuideline.(map[string]any)
			if !ok {
				continue
			}
			annotations, _ := guideline["annotations"].([]any)
			keptAnnotations := make([]any, 0, len(annotations))
			for _, rawAnnotation := range annotations {
				annotation, ok := rawAnnotation.(map[string]any)
				if ok && !annotationUsesGene(annotation, "CYP2D6") {
					keptAnnotations = append(keptAnnotations, annotation)
				}
			}
			if len(keptAnnotations) != 0 {
				copyGuideline := make(map[string]any, len(guideline))
				for key, value := range guideline {
					copyGuideline[key] = value
				}
				copyGuideline["annotations"] = keptAnnotations
				keptGuidelines = append(keptGuidelines, copyGuideline)
			}
		}
		if len(keptGuidelines) != 0 {
			copyDrug := make(map[string]any, len(drug))
			for key, value := range drug {
				copyDrug[key] = value
			}
			copyDrug["guidelines"] = keptGuidelines
			restrictedCPIC[drugName] = copyDrug
		}
	}
	if len(restrictedCPIC) == 0 {
		return nil, errors.New("reporter has no supported non-CYP2D6 CPIC annotation")
	}
	restricted["drugs"] = map[string]any{"CPIC Guideline Annotation": restrictedCPIC}
	return restricted, nil
}

func openMaybeGzip(path string) (io.ReadCloser, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(path, ".gz") || strings.HasSuffix(path, ".bgz") {
		reader, err := gzip.NewReader(file)
		if err != nil {
			file.Close()
			return nil, err
		}
		return &compoundCloser{Reader: reader, closers: []io.Closer{reader, file}}, nil
	}
	return file, nil
}

type compoundCloser struct {
	io.Reader
	closers []io.Closer
}

func (c *compoundCloser) Close() error {
	var first error
	for _, closer := range c.closers {
		if err := closer.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func parsePX(info string) []string {
	for _, field := range strings.Split(info, ";") {
		if strings.HasPrefix(field, "PX=") {
			var genes []string
			for _, gene := range strings.Split(strings.TrimPrefix(field, "PX="), ",") {
				gene = strings.TrimSpace(gene)
				if gene != "" {
					genes = append(genes, gene)
				}
			}
			return genes
		}
	}
	return nil
}

type coveragePositions struct {
	Called  map[string]map[string]struct{}
	Missing map[string]map[string]struct{}
}

func addCoveragePosition(target map[string]map[string]struct{}, gene, label string) {
	positions := target[gene]
	if positions == nil {
		positions = map[string]struct{}{}
		target[gene] = positions
	}
	positions[label] = struct{}{}
}

func vcfPositions(path string, missingArtifact bool) (coveragePositions, error) {
	reader, err := openMaybeGzip(path)
	if err != nil {
		return coveragePositions{}, err
	}
	defer reader.Close()
	result := coveragePositions{
		Called:  map[string]map[string]struct{}{},
		Missing: map[string]map[string]struct{}{},
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxVCFLineBytes)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 8 {
			return coveragePositions{}, errors.New("coverage VCF row is invalid")
		}
		label := fields[2]
		if label == "" || label == "." {
			label = strings.Join([]string{fields[0], fields[1], fields[3], fields[4]}, ":")
		}
		target := result.Missing
		if !missingArtifact && calledGenotypeFromRow(fields) {
			target = result.Called
		}
		for _, gene := range parsePX(fields[7]) {
			addCoveragePosition(target, gene, label)
		}
	}
	if err := scanner.Err(); err != nil {
		return coveragePositions{}, err
	}
	return result, nil
}

func measuredCoverage(preprocessedPath, missingPath string) (coverageDocument, int, error) {
	preprocessed, err := vcfPositions(preprocessedPath, false)
	if err != nil {
		return coverageDocument{}, 0, err
	}
	missingArtifact, err := vcfPositions(missingPath, true)
	if err != nil {
		return coverageDocument{}, 0, err
	}
	genes := map[string]geneCoverage{}
	totalMissing := 0
	for _, gene := range []string{"CYP2C19", "CYP2B6"} {
		missing := map[string]struct{}{}
		for label := range preprocessed.Missing[gene] {
			missing[label] = struct{}{}
		}
		for label := range missingArtifact.Missing[gene] {
			missing[label] = struct{}{}
		}
		missingLabels := make([]string, 0, len(missing))
		for label := range missing {
			missingLabels = append(missingLabels, label)
			delete(preprocessed.Called[gene], label)
		}
		sort.Strings(missingLabels)
		denominator := len(preprocessed.Called[gene]) + len(missingLabels)
		if denominator == 0 {
			return coverageDocument{}, 0, fmt.Errorf("coverage denominator is zero for %s", gene)
		}
		genes[gene] = geneCoverage{
			Status:                "measured",
			PositionsCalled:       len(preprocessed.Called[gene]),
			PositionsMissing:      len(missingLabels),
			MissingPositionLabels: missingLabels,
		}
		totalMissing += len(missingLabels)
	}
	return coverageDocument{SchemaVersion: "1.0", Genes: genes}, totalMissing, nil
}

func pharmCATCommand(ctx context.Context, workingDirectory string, logFile io.Writer) *exec.Cmd {
	command := exec.CommandContext(ctx, "pharmcat_pipeline", pharmCATArguments...)
	command.Dir = workingDirectory
	command.Stdout = logFile
	command.Stderr = logFile
	return command
}

func runPharmCAT(ctx context.Context, workingDirectory, logPath string) error {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	command := pharmCATCommand(ctx, workingDirectory, logFile)
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &workerError{code: "pharmcat_timed_out", message: "PharmCAT exceeded its run deadline.", cause: err}
		}
		return &workerError{code: "pharmcat_failed", message: "PharmCAT did not produce a complete result.", cause: err}
	}
	return nil
}

func analyse(ctx context.Context, client *googleClient, cfg config) error {
	loaded, err := client.getJSON(ctx, cfg.bucket, stateObject(cfg), 128*1024)
	if err != nil {
		return &workerError{code: "run_state_invalid", message: "The sealed run state could not be loaded.", cause: err}
	}
	if valueString(loaded.Value, "runId") != cfg.runID || valueString(loaded.Value, "tenantId") != cfg.tenantID || valueString(loaded.Value, "status") != "queued" {
		return &workerError{code: "run_state_invalid", message: "The sealed run state was not queued for this worker.", cause: errors.New("state identity or status mismatch")}
	}
	loaded, err = updateState(ctx, client, cfg, loaded, "running", map[string]any{
		"startedAt":       time.Now().UTC().Format(time.RFC3339Nano),
		"workerExecution": cfg.execution,
	})
	if err != nil {
		return &workerError{code: "run_state_conflict", message: "The sealed run state changed before analysis started.", cause: err}
	}
	if err := appendEvent(ctx, client, cfg, "running", map[string]any{"workerExecution": cfg.execution}); err != nil {
		return &workerError{code: "audit_write_failed", message: "The run audit trail could not be written.", cause: err}
	}

	input, err := inputRecord(loaded.Value)
	if err != nil {
		return &workerError{code: "run_state_invalid", message: "The sealed input metadata is invalid.", cause: err}
	}
	format := valueString(input, "format")
	if format != "vcf" && format != "vcf-gzip" {
		return &workerError{code: "unsupported_input", message: "Only GRCh38 single-sample VCF or VCF.gz input is supported.", cause: errors.New("unsupported format")}
	}
	declaredSize, ok := valueInt64(input, "sizeBytes")
	if !ok || declaredSize <= 0 || declaredSize > maxInputBytes {
		return &workerError{code: "input_integrity_failed", message: "The sealed input size is invalid.", cause: errors.New("invalid size")}
	}
	generation := valueString(input, "objectGeneration")
	if generation == "" {
		return &workerError{code: "input_integrity_failed", message: "The sealed input generation is missing.", cause: errors.New("missing generation")}
	}
	metadata, err := client.metadata(ctx, cfg.bucket, inputObject(cfg))
	if err != nil || metadata.Generation != generation {
		return &workerError{code: "input_integrity_failed", message: "The sealed genome object changed before analysis.", cause: err}
	}

	temporaryRoot, err := os.MkdirTemp("", "pgx-pharmcat-run-*")
	if err != nil {
		return &workerError{code: "worker_failed", message: "The PharmCAT worker could not create an isolated workspace.", cause: err}
	}
	defer os.RemoveAll(temporaryRoot)
	rawName := "input.vcf"
	if format == "vcf-gzip" {
		rawName = "input.vcf.gz"
	}
	rawPath := filepath.Join(temporaryRoot, rawName)
	rawFile, err := os.OpenFile(rawPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return &workerError{code: "worker_failed", message: "The PharmCAT worker could not create an isolated input file.", cause: err}
	}
	size, inputHash, err := client.download(ctx, cfg.bucket, inputObject(cfg), metadata, rawFile, maxInputBytes)
	closeErr := rawFile.Close()
	if err != nil || closeErr != nil || size != declaredSize {
		return &workerError{code: "input_integrity_failed", message: "The sealed genome object failed its integrity check.", cause: errors.Join(err, closeErr)}
	}
	if browserHash := valueString(input, "browserSha256"); browserHash != "" && browserHash != inputHash {
		return &workerError{code: "input_hash_mismatch", message: "The uploaded genome did not match the browser preflight hash.", cause: errors.New("hash mismatch")}
	}

	vcfPath := rawPath
	uncompressedSize := size
	if format == "vcf-gzip" {
		vcfPath = filepath.Join(temporaryRoot, "input.vcf")
		uncompressedSize, err = copyGzip(rawPath, vcfPath)
		if err != nil {
			return &workerError{code: "invalid_gzip", message: "The compressed VCF could not be read safely.", cause: err}
		}
	}
	recordCount, sampleCount, err := validateVCF(vcfPath)
	if err != nil {
		return &workerError{code: "invalid_vcf", message: "The file is not a verified GRCh38 single-sample VCF.", cause: err}
	}

	outputPath := filepath.Join(temporaryRoot, "output")
	if err := os.Mkdir(outputPath, 0o700); err != nil {
		return &workerError{code: "worker_failed", message: "The PharmCAT worker could not create its output directory.", cause: err}
	}
	commandContext, cancel := context.WithTimeout(ctx, cfg.commandTimeout)
	defer cancel()
	if err := runPharmCAT(commandContext, temporaryRoot, filepath.Join(temporaryRoot, "pharmcat.log")); err != nil {
		return err
	}

	reportPath, err := findExactlyOne(outputPath, "*.report.json")
	if err != nil {
		return &workerError{code: "pharmcat_output_incomplete", message: "PharmCAT did not produce exactly one Reporter JSON result.", cause: err}
	}
	missingPath, err := findExactlyOne(outputPath, "*.missing_pgx_var.vcf")
	if err != nil {
		return &workerError{code: "pharmcat_output_incomplete", message: "PharmCAT did not produce its missing-position artefact.", cause: err}
	}
	preprocessedPath, err := findExactlyOne(outputPath, "*.preprocessed.vcf", "*.preprocessed.vcf.gz", "*.preprocessed.vcf.bgz")
	if err != nil {
		return &workerError{code: "coverage_unavailable", message: "Per-gene PharmCAT input coverage could not be measured.", cause: err}
	}
	reportBytes, err := readLimited(reportPath, maxOutputBytes)
	if err != nil {
		return &workerError{code: "pharmcat_output_invalid", message: "The PharmCAT Reporter JSON exceeded its output limit.", cause: err}
	}
	var report map[string]any
	if err := json.Unmarshal(reportBytes, &report); err != nil {
		return &workerError{code: "pharmcat_output_invalid", message: "The PharmCAT Reporter JSON is invalid.", cause: err}
	}
	version := valueString(report, "pharmcatVersion")
	dataVersion := valueString(report, "dataVersion")
	if version == "" {
		return &workerError{code: "pharmcat_output_invalid", message: "The PharmCAT Reporter JSON has no software version.", cause: errors.New("missing version")}
	}
	restricted, err := restrictReporter(report)
	if err != nil {
		return &workerError{code: "pharmcat_output_invalid", message: "The PharmCAT result could not be restricted to supported calls.", cause: err}
	}
	restrictedBytes, err := json.Marshal(restricted)
	if err != nil {
		return &workerError{code: "pharmcat_output_invalid", message: "The restricted PharmCAT result could not be encoded.", cause: err}
	}
	coverage, missingCount, err := measuredCoverage(preprocessedPath, missingPath)
	if err != nil {
		return &workerError{code: "coverage_unavailable", message: "Per-gene PharmCAT input coverage could not be measured.", cause: err}
	}
	coverage.RunID = cfg.runID
	coverageBytes, err := json.Marshal(coverage)
	if err != nil {
		return &workerError{code: "coverage_unavailable", message: "Per-gene PharmCAT input coverage could not be recorded.", cause: err}
	}
	missingBytes, err := readLimited(missingPath, maxOutputBytes)
	if err != nil {
		return &workerError{code: "coverage_unavailable", message: "The PharmCAT missing-position artefact is invalid.", cause: err}
	}

	if _, err := client.uploadBytes(ctx, cfg.bucket, runObject(cfg, "output/reporter.original.json"), reportBytes, "application/json", "0"); err != nil {
		return &workerError{code: "output_write_failed", message: "The PharmCAT output could not be sealed.", cause: err}
	}
	if _, err := client.uploadBytes(ctx, cfg.bucket, runObject(cfg, "output/reporter.restricted.json"), restrictedBytes, "application/json", "0"); err != nil {
		return &workerError{code: "output_write_failed", message: "The restricted PharmCAT output could not be sealed.", cause: err}
	}
	if _, err := client.uploadBytes(ctx, cfg.bucket, runObject(cfg, "output/missing_pgx_var.vcf"), missingBytes, "text/vcf", "0"); err != nil {
		return &workerError{code: "output_write_failed", message: "The PharmCAT coverage artefact could not be sealed.", cause: err}
	}
	missingHash := sha256Hex(missingBytes)
	if _, err := client.uploadBytes(ctx, cfg.bucket, runObject(cfg, "output/coverage.json"), coverageBytes, "application/json", "0"); err != nil {
		return &workerError{code: "output_write_failed", message: "The PharmCAT coverage summary could not be sealed.", cause: err}
	}

	startedAt := valueString(loaded.Value, "startedAt")
	completedAt := time.Now().UTC().Format(time.RFC3339Nano)
	manifest := map[string]any{
		"schemaVersion": "1.0",
		"runId":         cfg.runID,
		"status":        "complete",
		"createdAt":     valueString(loaded.Value, "createdAt"),
		"startedAt":     startedAt,
		"completedAt":   completedAt,
		"input": map[string]any{
			"format":                format,
			"sizeBytes":             size,
			"sha256":                inputHash,
			"objectGeneration":      generation,
			"genomeBuild":           "GRCh38",
			"sampleCount":           sampleCount,
			"recordCount":           recordCount,
			"uncompressedSizeBytes": uncompressedSize,
		},
		"caller": map[string]any{
			"image":               cfg.image,
			"imageDigest":         cfg.imageDigest,
			"workerImageDigest":   cfg.workerDigest,
			"command":             append([]string{"pharmcat_pipeline"}, pharmCATArguments...),
			"pharmcatVersion":     version,
			"pharmcatDataVersion": nullableString(dataVersion),
			"cloudRunExecution":   cfg.execution,
			"cyp2d6OutsideCall":   false,
		},
		"outputs": map[string]any{
			"reporterSha256":           sha256Hex(reportBytes),
			"restrictedReporterSha256": sha256Hex(restrictedBytes),
			"missingPositionsSha256":   missingHash,
			"coverageSha256":           sha256Hex(coverageBytes),
			"missingPositionCount":     missingCount,
		},
		"coverage": coverage.Genes,
		"exclusions": []map[string]any{{
			"gene":   "CYP2D6",
			"reason": "No validated structural/copy-number-aware CYP2D6 outside call was supplied for this run.",
		}},
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return &workerError{code: "output_write_failed", message: "The final run manifest could not be encoded.", cause: err}
	}
	if _, err := client.uploadBytes(ctx, cfg.bucket, runObject(cfg, "manifest.final.json"), manifestBytes, "application/json", "0"); err != nil {
		return &workerError{code: "output_write_failed", message: "The final run manifest could not be sealed.", cause: err}
	}
	loaded, err = client.getJSON(ctx, cfg.bucket, stateObject(cfg), 128*1024)
	if err != nil || valueString(loaded.Value, "status") != "running" || valueString(loaded.Value, "workerExecution") != cfg.execution {
		return &workerError{code: "run_state_conflict", message: "The sealed run state changed before completion.", cause: err}
	}
	if _, err := updateState(ctx, client, cfg, loaded, "complete", map[string]any{"completedAt": completedAt}); err != nil {
		return &workerError{code: "run_state_conflict", message: "The sealed result could not be committed.", cause: err}
	}
	if err := appendEvent(ctx, client, cfg, "complete", map[string]any{"manifestSha256": sha256Hex(manifestBytes)}); err != nil {
		return &workerError{code: "audit_write_failed", message: "The completed run audit event could not be written.", cause: err}
	}
	return nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func main() {
	cfg, err := readConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "worker configuration failed")
		os.Exit(1)
	}
	client, err := newGoogleClient()
	if err != nil {
		fmt.Fprintln(os.Stderr, "worker authentication failed")
		os.Exit(1)
	}
	ctx := context.Background()
	err = analyse(ctx, client, cfg)
	if err == nil {
		return
	}
	code := "worker_failed"
	message := "The PharmCAT worker failed safely."
	var typed *workerError
	if errors.As(err, &typed) {
		code = typed.code
		message = typed.message
	}
	failRun(ctx, client, cfg, code, message)
	fmt.Fprintln(os.Stderr, "worker failed:", code)
	os.Exit(1)
}
