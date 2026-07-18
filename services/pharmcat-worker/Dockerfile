ARG GO_IMAGE
ARG PHARMCAT_IMAGE

FROM ${GO_IMAGE} AS builder
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/pgx-pharmcat-worker ./cmd/worker

FROM ${PHARMCAT_IMAGE}
USER root
COPY --from=builder /out/pgx-pharmcat-worker /usr/local/bin/pgx-pharmcat-worker

# Genome files are untrusted input. The worker needs only the image's read-only PharmCAT
# installation plus its own directory under /tmp, so it must not run as root.
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/pgx-pharmcat-worker"]
