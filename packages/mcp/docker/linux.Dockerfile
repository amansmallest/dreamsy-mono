# dreamsy-tool for the dreamsy-mcp npm package (linux, glibc 2.35+, static C++ runtime)
#   docker build --platform linux/amd64 -f packages/mcp/docker/linux.Dockerfile --output packages/mcp/prebuilt/linux-x64 .   (or --platform linux/arm64 → prebuilt/linux-arm64)
FROM ubuntu:22.04 AS tool
RUN apt-get update && apt-get install -y --no-install-recommends clang-15 libstdc++-12-dev ninja-build python3 python3-pip \
 && pip3 install --no-cache-dir "cmake>=3.28,<4" && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY engine engine
COPY third_party third_party
COPY format/catalog.json format/dreamsy.d.luau format/
COPY kits kits
COPY games/examples/feature-demo games/examples/feature-demo
RUN cd /src/engine && CC=clang-15 CXX=clang++-15 cmake --preset release -DDREAMSY_BUILD_PLAYER=OFF -DDREAMSY_BUILD_TESTS=OFF \
      -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
 && cmake --build --preset release --target dreamsy-tool \
 && strip build/release/dreamsy-tool

FROM scratch
COPY --from=tool /src/engine/build/release/dreamsy-tool /dreamsy-tool
