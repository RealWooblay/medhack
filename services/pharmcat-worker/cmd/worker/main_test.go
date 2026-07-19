package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"hash/crc32"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

type oneShotReadCloser struct {
	value []byte
	done  bool
}

func (reader *oneShotReadCloser) Read(destination []byte) (int, error) {
	if reader.done {
		return 0, io.ErrUnexpectedEOF
	}
	reader.done = true
	return copy(destination, reader.value), io.ErrUnexpectedEOF
}

func (reader *oneShotReadCloser) Close() error {
	return nil
}

func metadataForPayload(payload []byte) *objectMetadata {
	crc := crc32.New(crc32cTable)
	_, _ = crc.Write(payload)
	md5Sum := md5.Sum(payload)
	return &objectMetadata{
		Generation: "42",
		Size:       strconv.Itoa(len(payload)),
		CRC32C:     base64.StdEncoding.EncodeToString(crc.Sum(nil)),
		MD5Hash:    base64.StdEncoding.EncodeToString(md5Sum[:]),
	}
}

func downloadTestClient(transport http.RoundTripper) *googleClient {
	return &googleClient{
		httpClient:          &http.Client{Transport: transport},
		accessToken:         "test-token",
		downloadIdleTimeout: time.Minute,
		maxDownloadAttempts: maxDownloadAttempts,
		waitBeforeDownloadRetry: func(context.Context, int) error {
			return nil
		},
	}
}

func downloadDestination(t *testing.T) *os.File {
	t.Helper()
	destination, err := os.Create(filepath.Join(t.TempDir(), "download"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = destination.Close() })
	return destination
}

func writeTestFile(t *testing.T, name, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func validVCF(sampleColumns string) string {
	return "##fileformat=VCFv4.2\n" +
		"##contig=<ID=1,length=248956422>\n" +
		"##contig=<ID=2,length=242193529>\n" +
		"##contig=<ID=3,length=198295559>\n" +
		"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t" + sampleColumns + "\n" +
		"1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0/1\n"
}

func TestValidateVCFAcceptsVerifiedSingleSampleGRCh38(t *testing.T) {
	path := writeTestFile(t, "input.vcf", validVCF("sample"))
	records, samples, err := validateVCF(path)
	if err != nil {
		t.Fatalf("validateVCF returned error: %v", err)
	}
	if records != 1 || samples != 1 {
		t.Fatalf("got records=%d samples=%d", records, samples)
	}
}

func TestCommittedDemoVCFPassesTheRealWorkerValidation(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "public", "samples", "pharmcat-example.vcf")
	records, samples, err := validateVCF(path)
	if err != nil {
		t.Fatalf("committed demo VCF is not accepted by the real worker: %v", err)
	}
	if records != 1226 || samples != 1 {
		t.Fatalf("unexpected committed demo shape: records=%d samples=%d", records, samples)
	}
}

func TestValidateVCFRejectsNonPositivePositions(t *testing.T) {
	for _, position := range []string{"0", "-1"} {
		t.Run(position, func(t *testing.T) {
			contents := strings.Replace(validVCF("sample"), "\t100\t", "\t"+position+"\t", 1)
			path := writeTestFile(t, "invalid-position.vcf", contents)
			if _, _, err := validateVCF(path); err == nil {
				t.Fatalf("expected position %s to fail", position)
			}
		})
	}
}

func TestValidateVCFRejectsFilesWithoutARealCalledGenotype(t *testing.T) {
	for _, genotype := range []string{".", "./.", ".|.", "0/.", "./1"} {
		t.Run(genotype, func(t *testing.T) {
			contents := strings.Replace(validVCF("sample"), "\t0/1\n", "\t"+genotype+"\n", 1)
			path := writeTestFile(t, "no-call.vcf", contents)
			if _, _, err := validateVCF(path); err == nil {
				t.Fatalf("expected genotype %q not to establish a called VCF", genotype)
			}
		})
	}
}

func TestReadConfigAcceptsPinnedOfficialImageDigest(t *testing.T) {
	t.Setenv("PGX_RUN_ID", "11111111-1111-4111-8111-111111111111")
	t.Setenv("PGX_TENANT_ID", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	t.Setenv("PHARMCAT_RUN_BUCKET", "pgx-run-test")
	t.Setenv("PHARMCAT_IMAGE", "pgkb/pharmcat:3.3.0@sha256:e9b02865a0abe1a0085ac0d7625f1ec33a06a56e9571d5befb16f90d4fedc435")
	t.Setenv("PGX_WORKER_IMAGE_DIGEST", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	t.Setenv("CLOUD_RUN_EXECUTION", "pharmcat-worker-test")
	t.Setenv("CLOUD_RUN_TASK_ATTEMPT", "0")
	cfg, err := readConfig()
	if err != nil {
		t.Fatalf("readConfig returned error: %v", err)
	}
	if cfg.imageDigest != "sha256:e9b02865a0abe1a0085ac0d7625f1ec33a06a56e9571d5befb16f90d4fedc435" {
		t.Fatalf("unexpected image digest %q", cfg.imageDigest)
	}
}

func TestStorageObjectURLUsesExactlyOneEscapeForStateObject(t *testing.T) {
	cfg := config{
		runID:    "11111111-1111-4111-8111-111111111111",
		tenantID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
	object := stateObject(cfg)
	target := storageObjectURL("pgx-run-test", object, map[string]string{
		"alt":               "media",
		"ifGenerationMatch": "42",
	})
	expectedPath := "/storage/v1/b/pgx-run-test/o/runs%2F" + cfg.tenantID + "%2F" + cfg.runID + "%2Fstate.json"
	if target.EscapedPath() != expectedPath {
		t.Fatalf("unexpected escaped path: %s", target.EscapedPath())
	}
	if strings.Contains(target.String(), "%252F") {
		t.Fatalf("object slash was double escaped: %s", target.String())
	}
	if target.Query().Get("alt") != "media" || target.Query().Get("ifGenerationMatch") != "42" {
		t.Fatalf("unexpected query: %s", target.RawQuery)
	}
}

func TestStorageObjectURLUsesExactlyOneEscapeForInputObject(t *testing.T) {
	cfg := config{
		runID:    "11111111-1111-4111-8111-111111111111",
		tenantID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
	target := storageObjectURL("pgx-run-test", inputObject(cfg), nil)
	expected := "https://storage.googleapis.com/storage/v1/b/pgx-run-test/o/runs%2F" +
		cfg.tenantID + "%2F" + cfg.runID + "%2Finput%2Fsource"
	if target.String() != expected {
		t.Fatalf("unexpected input object URL:\nwant %s\n got %s", expected, target.String())
	}
}

func TestGoogleHTTPClientHasNoWholeRequestTimeout(t *testing.T) {
	client := newGoogleHTTPClient()
	if client.Timeout != 0 {
		t.Fatalf("whole-request timeout must be disabled, got %s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("unexpected transport type %T", client.Transport)
	}
	if transport.ResponseHeaderTimeout != 30*time.Second || transport.TLSHandshakeTimeout != 10*time.Second {
		t.Fatalf("connection/header deadlines are not configured: %#v", transport)
	}
}

func TestDownloadLocksGenerationAndVerifiesCloudStorageChecksums(t *testing.T) {
	payload := []byte("authoritative genome bytes")
	metadata := metadataForPayload(payload)
	requests := 0
	client := downloadTestClient(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		query := request.URL.Query()
		if query.Get("generation") != metadata.Generation || query.Get("ifGenerationMatch") != metadata.Generation {
			t.Errorf("download was not locked to generation %s: %s", metadata.Generation, request.URL.RawQuery)
		}
		if request.Header.Get("Accept-Encoding") != "identity" {
			t.Errorf("unexpected Accept-Encoding %q", request.Header.Get("Accept-Encoding"))
		}
		if request.Header.Get("Range") != "" {
			t.Errorf("initial request unexpectedly used a range: %q", request.Header.Get("Range"))
		}
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"X-Goog-Generation": []string{metadata.Generation}},
			Body:          io.NopCloser(bytes.NewReader(payload)),
			ContentLength: int64(len(payload)),
		}, nil
	}))
	destination := downloadDestination(t)
	size, digest, err := client.download(context.Background(), "pgx-run-test", "runs/test/input/source", metadata, destination, int64(len(payload)))
	if err != nil {
		t.Fatalf("download returned error: %v", err)
	}
	if requests != 1 || size != int64(len(payload)) || digest != sha256Hex(payload) {
		t.Fatalf("unexpected result: requests=%d size=%d digest=%q", requests, size, digest)
	}
	if _, err := destination.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	stored, err := io.ReadAll(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, payload) {
		t.Fatalf("downloaded bytes changed: %q", stored)
	}
}

func TestDownloadRejectsMissingAuthoritativeChecksumBeforeNetworkRead(t *testing.T) {
	metadata := &objectMetadata{Generation: "42", Size: "4"}
	requests := 0
	client := downloadTestClient(roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		return nil, errors.New("network should not be called")
	}))
	_, _, err := client.download(context.Background(), "pgx-run-test", "object", metadata, downloadDestination(t), 4)
	if err == nil || !strings.Contains(err.Error(), "no authoritative checksum") {
		t.Fatalf("expected missing checksum to fail closed, got %v", err)
	}
	if requests != 0 {
		t.Fatalf("download made %d network requests before rejecting metadata", requests)
	}
}

func TestDownloadDoesNotRetryPermanentRequestFailure(t *testing.T) {
	payload := []byte("checksum-bound object")
	metadata := metadataForPayload(payload)
	requests := 0
	permanent := errors.New("permanent request construction failure")
	client := downloadTestClient(roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		return nil, permanent
	}))
	_, _, err := client.download(context.Background(), "pgx-run-test", "object", metadata, downloadDestination(t), int64(len(payload)))
	if !errors.Is(err, permanent) {
		t.Fatalf("expected permanent request error, got %v", err)
	}
	if requests != 1 {
		t.Fatalf("permanent request error was retried %d times", requests)
	}
}

func TestDownloadRejectsMismatchInAnyAdvertisedChecksumWithoutRetry(t *testing.T) {
	payload := []byte("checksum-bound object")
	metadata := metadataForPayload(payload)
	metadata.MD5Hash = base64.StdEncoding.EncodeToString(make([]byte, md5.Size))
	requests := 0
	client := downloadTestClient(roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        make(http.Header),
			Body:          io.NopCloser(bytes.NewReader(payload)),
			ContentLength: int64(len(payload)),
		}, nil
	}))
	_, _, err := client.download(context.Background(), "pgx-run-test", "object", metadata, downloadDestination(t), int64(len(payload)))
	if err == nil || !strings.Contains(err.Error(), "MD5 checksum") {
		t.Fatalf("expected MD5 mismatch to fail closed, got %v", err)
	}
	if requests != 1 {
		t.Fatalf("checksum mismatch was retried %d times", requests)
	}
}

func TestDownloadResumesFromExactOffsetAgainstSameGeneration(t *testing.T) {
	payload := []byte("a generation-locked resumable object")
	prefixLength := 9
	metadata := metadataForPayload(payload)
	requests := 0
	client := downloadTestClient(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		query := request.URL.Query()
		if query.Get("generation") != metadata.Generation || query.Get("ifGenerationMatch") != metadata.Generation {
			t.Errorf("attempt %d changed generation selectors: %s", requests, request.URL.RawQuery)
		}
		if requests == 1 {
			if request.Header.Get("Range") != "" {
				t.Errorf("initial request unexpectedly used range %q", request.Header.Get("Range"))
			}
			return &http.Response{
				StatusCode:    http.StatusOK,
				Header:        make(http.Header),
				Body:          &oneShotReadCloser{value: payload[:prefixLength]},
				ContentLength: int64(len(payload)),
			}, nil
		}
		expectedRange := "bytes=" + strconv.Itoa(prefixLength) + "-"
		if request.Header.Get("Range") != expectedRange {
			t.Errorf("resume range = %q, want %q", request.Header.Get("Range"), expectedRange)
		}
		return &http.Response{
			StatusCode: http.StatusPartialContent,
			Header: http.Header{
				"Content-Range":     []string{"bytes " + strconv.Itoa(prefixLength) + "-" + strconv.Itoa(len(payload)-1) + "/" + strconv.Itoa(len(payload))},
				"X-Goog-Generation": []string{metadata.Generation},
			},
			Body:          io.NopCloser(bytes.NewReader(payload[prefixLength:])),
			ContentLength: int64(len(payload) - prefixLength),
		}, nil
	}))
	destination := downloadDestination(t)
	size, digest, err := client.download(context.Background(), "pgx-run-test", "object", metadata, destination, int64(len(payload)))
	if err != nil {
		t.Fatalf("resumed download returned error: %v", err)
	}
	if requests != 2 || size != int64(len(payload)) || digest != sha256Hex(payload) {
		t.Fatalf("unexpected resumed result: requests=%d size=%d digest=%q", requests, size, digest)
	}
	if _, err := destination.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	stored, err := io.ReadAll(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, payload) {
		t.Fatalf("resumed bytes changed: %q", stored)
	}
}

func TestDownloadRejectsFullResponseForRangeResume(t *testing.T) {
	payload := []byte("do not append a repeated full response")
	prefixLength := 8
	metadata := metadataForPayload(payload)
	requests := 0
	client := downloadTestClient(roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		if requests == 1 {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Header:        make(http.Header),
				Body:          &oneShotReadCloser{value: payload[:prefixLength]},
				ContentLength: int64(len(payload)),
			}, nil
		}
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        make(http.Header),
			Body:          io.NopCloser(bytes.NewReader(payload)),
			ContentLength: int64(len(payload) - prefixLength),
		}, nil
	}))
	_, _, err := client.download(context.Background(), "pgx-run-test", "object", metadata, downloadDestination(t), int64(len(payload)))
	if err == nil || !strings.Contains(err.Error(), "resumed object read status 200") {
		t.Fatalf("expected a non-partial resume to fail closed, got %v", err)
	}
	if requests != 2 {
		t.Fatalf("invalid range response was retried %d times", requests)
	}
}

func TestValidateVCFRejectsUnverifiedBuild(t *testing.T) {
	contents := "##fileformat=VCFv4.2\n##reference=GRCh37\n" +
		"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tsample\n" +
		"1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0/1\n"
	path := writeTestFile(t, "input.vcf", contents)
	if _, _, err := validateVCF(path); err == nil {
		t.Fatal("expected GRCh37 input to fail")
	}
}

func TestValidateVCFAcceptsOfficialAssemblyStyleContigHeader(t *testing.T) {
	contents := "##fileformat=VCFv4.2\n" +
		"##contig=<ID=chr1,assembly=GRCh38.p14>\n" +
		"##contig=<ID=chr2,assembly=GRCh38.p14>\n" +
		"##contig=<ID=chr3,assembly=GRCh38.p14>\n" +
		"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tsample\n" +
		"chr1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0/1\n"
	path := writeTestFile(t, "official-style.vcf", contents)
	if _, _, err := validateVCF(path); err != nil {
		t.Fatalf("official GRCh38 assembly header was rejected: %v", err)
	}
}

func TestValidateVCFDoesNotCountDuplicateContigsAsBuildEvidence(t *testing.T) {
	contents := "##fileformat=VCFv4.2\n" +
		"##contig=<ID=chr1,assembly=GRCh38.p14>\n" +
		"##contig=<ID=chr1,assembly=GRCh38.p14>\n" +
		"##contig=<ID=chr1,assembly=GRCh38.p14>\n" +
		"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tsample\n" +
		"chr1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0/1\n"
	path := writeTestFile(t, "duplicate-contigs.vcf", contents)
	if _, _, err := validateVCF(path); err == nil {
		t.Fatal("expected duplicate contigs not to establish GRCh38")
	}
}

func TestValidateVCFRejectsLooseBuildSubstring(t *testing.T) {
	contents := "##fileformat=VCFv4.2\n" +
		"##reference=notb38-reference\n" +
		"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tsample\n" +
		"chr1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0/1\n"
	path := writeTestFile(t, "loose-build.vcf", contents)
	if _, _, err := validateVCF(path); err == nil {
		t.Fatal("expected a loose b38 substring not to establish GRCh38")
	}
}

func TestRecordedPharmCATCommandMatchesLiteralInvocation(t *testing.T) {
	command := pharmCATCommand(context.Background(), "/isolated/run", io.Discard)
	want := append([]string{"pharmcat_pipeline"}, pharmCATArguments...)
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("command mismatch: want %#v, got %#v", want, command.Args)
	}
	if command.Dir != "/isolated/run" {
		t.Fatalf("unexpected command directory %q", command.Dir)
	}
	for _, argument := range command.Args[1:] {
		if filepath.IsAbs(argument) {
			t.Fatalf("recorded command contains an absolute path: %q", argument)
		}
	}
}

func TestValidateVCFRejectsMultipleSamples(t *testing.T) {
	contents := validVCF("sample1\tsample2")
	contents = contents[:len(contents)-4] + "\t0/0\n"
	path := writeTestFile(t, "input.vcf", contents)
	if _, _, err := validateVCF(path); err == nil {
		t.Fatal("expected multiple samples to fail")
	}
}

func TestMeasuredCoverageUsesPXGeneAndKeepsMissingLabels(t *testing.T) {
	header := "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSample\n"
	preprocessed := writeTestFile(t, "sample.preprocessed.vcf", header+
		"chr10\t1\trs-called-19\tA\tG\t.\tPASS\tPX=CYP2C19\tGT\t0/1\n"+
		"chr19\t2\trs-called-6\tC\tT\t.\tPASS\tPX=CYP2B6\tGT\t0/0\n")
	missing := writeTestFile(t, "sample.missing_pgx_var.vcf", header+
		"chr10\t3\trs-missing-19\tA\tC\t.\tPASS\tPX=CYP2C19\tGT\t./.\n")
	coverage, total, err := measuredCoverage(preprocessed, missing)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || coverage.Genes["CYP2C19"].PositionsCalled != 1 || coverage.Genes["CYP2C19"].PositionsMissing != 1 {
		t.Fatalf("unexpected coverage: %#v", coverage.Genes)
	}
	if got := coverage.Genes["CYP2C19"].MissingPositionLabels; len(got) != 1 || got[0] != "rs-missing-19" {
		t.Fatalf("unexpected missing labels: %#v", got)
	}
}

func TestMeasuredCoverageTreatsPreprocessedNoCallsAsMissing(t *testing.T) {
	header := "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSample\n"
	preprocessed := writeTestFile(t, "sample.preprocessed.vcf", header+
		"chr10\t1\trs-no-call-19\tA\tG\t.\tPASS\tPX=CYP2C19\tGT\t./.\n"+
		"chr19\t2\trs-called-6\tC\tT\t.\tPASS\tPX=CYP2B6\tDP:GT\t12:0|1\n")
	missing := writeTestFile(t, "sample.missing_pgx_var.vcf", header)

	coverage, total, err := measuredCoverage(preprocessed, missing)
	if err != nil {
		t.Fatal(err)
	}
	gene19 := coverage.Genes["CYP2C19"]
	if total != 1 || gene19.PositionsCalled != 0 || gene19.PositionsMissing != 1 {
		t.Fatalf("preprocessed no-call was not classified as missing: %#v", coverage.Genes)
	}
	if len(gene19.MissingPositionLabels) != 1 || gene19.MissingPositionLabels[0] != "rs-no-call-19" {
		t.Fatalf("unexpected CYP2C19 missing labels: %#v", gene19.MissingPositionLabels)
	}
	gene6 := coverage.Genes["CYP2B6"]
	if gene6.PositionsCalled != 1 || gene6.PositionsMissing != 0 {
		t.Fatalf("called GT evidence was not retained: %#v", gene6)
	}
}

func TestMeasuredCoverageConservativelyMarksRowsWithoutGTEvidenceMissing(t *testing.T) {
	header := "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSample\n"
	preprocessed := writeTestFile(t, "sample.preprocessed.vcf", header+
		"chr10\t1\trs-no-format-19\tA\tG\t.\tPASS\tPX=CYP2C19\n"+
		"chr19\t2\trs-called-6\tC\tT\t.\tPASS\tPX=CYP2B6\tGT\t0/0\n")
	missing := writeTestFile(t, "sample.missing_pgx_var.vcf", header)

	coverage, total, err := measuredCoverage(preprocessed, missing)
	if err != nil {
		t.Fatal(err)
	}
	gene19 := coverage.Genes["CYP2C19"]
	if total != 1 || gene19.PositionsCalled != 0 || gene19.PositionsMissing != 1 {
		t.Fatalf("row without GT evidence was not classified as missing: %#v", coverage.Genes)
	}
}

func TestMeasuredCoverageRejectsZeroDenominatorForAnyRequiredGene(t *testing.T) {
	header := "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSample\n"
	preprocessed := writeTestFile(t, "sample.preprocessed.vcf", header+
		"chr10\t1\trs-called-19\tA\tG\t.\tPASS\tPX=CYP2C19\tGT\t0/1\n")
	missing := writeTestFile(t, "sample.missing_pgx_var.vcf", header)
	if _, _, err := measuredCoverage(preprocessed, missing); err == nil {
		t.Fatal("expected zero CYP2B6 coverage denominator to fail")
	}
}

func TestRestrictReporterRemovesCYP2D6CallsAndGuidance(t *testing.T) {
	report := map[string]any{
		"genes": map[string]any{
			"CYP2C19": map[string]any{"callSource": "VCF"},
			"CYP2D6":  map[string]any{"callSource": "VCF"},
		},
		"drugs": map[string]any{
			"CPIC Guideline Annotation": map[string]any{
				"citalopram": map[string]any{"guidelines": []any{
					map[string]any{"annotations": []any{annotationForGene("CYP2C19")}},
				}},
				"fluvoxamine": map[string]any{"guidelines": []any{
					map[string]any{"annotations": []any{annotationForGene("CYP2D6")}},
				}},
			},
			"FDA Label Annotation": map[string]any{"ignored": true},
		},
	}
	restricted, err := restrictReporter(report)
	if err != nil {
		t.Fatal(err)
	}
	genes := restricted["genes"].(map[string]any)
	if _, exists := genes["CYP2D6"]; exists {
		t.Fatal("CYP2D6 call was retained")
	}
	drugs := restricted["drugs"].(map[string]any)
	if len(drugs) != 1 {
		t.Fatalf("unexpected annotation families: %#v", drugs)
	}
	cpic := drugs["CPIC Guideline Annotation"].(map[string]any)
	if _, exists := cpic["fluvoxamine"]; exists {
		t.Fatal("CYP2D6 guidance was retained")
	}
	if _, exists := cpic["citalopram"]; !exists {
		t.Fatal("CYP2C19 guidance was removed")
	}
}

func TestDeriveReporterGeneScopePartitionsAndSortsReporterGenes(t *testing.T) {
	original := map[string]any{"genes": map[string]any{
		"HLA-B":   map[string]any{},
		"CYP2D6":  map[string]any{},
		"CYP2C19": map[string]any{},
		"CYP2B6":  map[string]any{},
		"SLCO1B1": map[string]any{},
	}}
	restricted := map[string]any{"genes": map[string]any{
		"CYP2C19": map[string]any{},
		"CYP2B6":  map[string]any{},
	}}

	scope, err := deriveReporterGeneScope(original, restricted)
	if err != nil {
		t.Fatal(err)
	}
	wantUnrestricted := []string{"CYP2B6", "CYP2C19", "CYP2D6", "HLA-B", "SLCO1B1"}
	if scope.UnrestrictedReporterGeneCount != len(wantUnrestricted) || !reflect.DeepEqual(scope.UnrestrictedReporterGenes, wantUnrestricted) {
		t.Fatalf("unrestricted genes were not counted and sorted from the report: %#v", scope)
	}
	if want := []string{"CYP2B6", "CYP2C19", "CYP2D6"}; !reflect.DeepEqual(scope.AntidepressantRelevantGenes, want) {
		t.Fatalf("unexpected antidepressant scope: %#v", scope.AntidepressantRelevantGenes)
	}
	if want := []string{"CYP2B6", "CYP2C19"}; !reflect.DeepEqual(scope.RetainedReporterGenes, want) {
		t.Fatalf("retained genes were not sorted: %#v", scope.RetainedReporterGenes)
	}
	wantWithheld := []withheldReporterGene{
		{Gene: "CYP2D6", Reason: cyp2d6WithheldReason},
		{Gene: "HLA-B", Reason: outsideAntidepressantScope},
		{Gene: "SLCO1B1", Reason: outsideAntidepressantScope},
	}
	if !reflect.DeepEqual(scope.WithheldReporterGenes, wantWithheld) {
		t.Fatalf("unexpected withheld-gene audit: %#v", scope.WithheldReporterGenes)
	}
	if len(scope.RetainedReporterGenes)+len(scope.WithheldReporterGenes) != scope.UnrestrictedReporterGeneCount {
		t.Fatalf("retained and withheld genes do not partition the unrestricted report: %#v", scope)
	}
}

func TestDeriveReporterGeneScopeDoesNotInventAbsentCYP2D6(t *testing.T) {
	original := map[string]any{"genes": map[string]any{
		"CYP2C19": map[string]any{},
		"CYP2B6":  map[string]any{},
	}}
	restricted := map[string]any{"genes": map[string]any{
		"CYP2B6":  map[string]any{},
		"CYP2C19": map[string]any{},
	}}

	scope, err := deriveReporterGeneScope(original, restricted)
	if err != nil {
		t.Fatal(err)
	}
	if len(scope.WithheldReporterGenes) != 0 {
		t.Fatalf("an absent Reporter gene was described as withheld: %#v", scope.WithheldReporterGenes)
	}
}

func TestDeriveReporterGeneScopeRejectsInvalidGeneMaps(t *testing.T) {
	tests := []struct {
		name       string
		original   map[string]any
		restricted map[string]any
	}{
		{
			name:       "malformed unrestricted genes",
			original:   map[string]any{"genes": []any{"CYP2C19"}},
			restricted: map[string]any{"genes": map[string]any{"CYP2C19": map[string]any{}}},
		},
		{
			name:       "restricted gene absent from original",
			original:   map[string]any{"genes": map[string]any{"CYP2C19": map[string]any{}}},
			restricted: map[string]any{"genes": map[string]any{"CYP2B6": map[string]any{}}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := deriveReporterGeneScope(test.original, test.restricted); err == nil {
				t.Fatal("expected invalid gene scope to fail")
			}
		})
	}
}

func annotationForGene(gene string) map[string]any {
	return map[string]any{
		"drugRecommendation": "test",
		"genotypes": []any{
			map[string]any{"diplotypes": []any{map[string]any{"gene": gene}}},
		},
	}
}
