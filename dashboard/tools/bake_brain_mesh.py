#!/usr/bin/env python3
"""Bake static/brain_mesh.bin from the fsaverage pial surface (no nibabel needed).

Source: work/dashboard-redesign-20261105/brainbake/nilearn_data/fsaverage (nilearn's fsaverage GIFTI files).
fsaverage vertices are nested: the first 10*4**k+2 vertices of the full mesh are the level-k icosphere. We
regenerate the level-LEVEL icosphere topology, match its vertices to the first N sphere vertices, and take the
pial positions at those ids, so the decimated mesh keeps the real cortex geometry.
Coordinates are written in the dashboard's BRAIN_MASK space (the same space the top-view image and node layout
use), X right, Y up, Z toward the viewer.

Layout of brain_mesh.bin (little endian):
  u32 magic 'BRN1', u32 nVerts, u32 nTris, f32 pos scale (positions are i16 = value * scale)
  i16[nVerts*3] positions, i8[nVerts*3] normals, u8[nVerts] sulc (0..255), u16[nTris*3] indices
Vertices 0..nLeft-1 are the left hemisphere (header stores u32 nLeft after the scale). Indices are LOCAL to each
hemisphere (0..nLeft-1): the first nTris/2 triangles use the left vertices, the rest the right vertices.
"""
import base64, gzip, struct, sys, xml.etree.ElementTree as ET, zlib
import numpy as np

D = '/home/ali3nz/docker/work/dashboard-redesign-20261105/brainbake/nilearn_data/fsaverage/'
LEVEL = int(sys.argv[1]) if len(sys.argv) > 1 else 6
OUT = sys.argv[2] if len(sys.argv) > 2 else '/home/ali3nz/docker/repoql-dashboard/static/brain_mesh.bin'
MASK_W, MASK_H, IMG_W, IMG_H = 666.7, 800.0, 1100, 1320  # bake.py: out('top',1100,1320)


def gii(path):
    r = ET.fromstring(gzip.open(path).read()); out = {}
    for da in r.iter('DataArray'):
        dt = {'NIFTI_TYPE_FLOAT32': '<f4', 'NIFTI_TYPE_INT32': '<i4'}[da.get('DataType')]
        dims = [int(da.get(f'Dim{i}')) for i in range(int(da.get('Dimensionality')))]
        raw = base64.b64decode(da.find('Data').text)
        if da.get('Encoding') == 'GZipBase64Binary': raw = zlib.decompress(raw)
        out[da.get('Intent')] = np.frombuffer(raw, dtype=dt).reshape(dims)
    return out


def coarsen(F, n_fine):
    """Invert one icosphere subdivision: fine faces whose three vertices are all new midpoints are the central
    children; the vertex opposite each of their edges (in the neighbouring corner face) is a parent corner."""
    n_old = (n_fine - 2) // 4 + 1  # 10*4**k+2 -> 10*4**(k-1)+2
    n_old = (n_fine - 2) // 4 + 2
    new = F >= n_old
    central = np.where(new.all(1))[0]
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    fid = np.concatenate([np.arange(len(F))] * 3)
    key = e[:, 0].astype(np.int64) * n_fine + e[:, 1]
    order = np.argsort(key, kind='stable'); ks = key[order]; fs = fid[order]
    out = []
    for fi in central:
        parents = []
        for j in range(3):
            a, b = sorted((F[fi, j], F[fi, (j + 1) % 3])); k = a * n_fine + b
            lo = np.searchsorted(ks, k); cand = fs[lo:lo + 2]
            other = cand[0] if cand[0] != fi else cand[1]
            opp = [v for v in F[other] if v != a and v != b][0]
            parents.append(opp)
        out.append(parents)
    return np.array(out), n_old


def vnormals(v, f):
    n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]); o = np.zeros_like(v)
    for i in range(3): np.add.at(o, f[:, i], n)
    return o / (np.linalg.norm(o, axis=1, keepdims=True) + 1e-9)


N = 10 * 4 ** LEVEL + 2
hemis = {}
for h in ('left', 'right'):
    g = gii(D + f'pial_{h}.gii.gz')
    pial = g['NIFTI_INTENT_POINTSET'].astype(np.float64); F = g['NIFTI_INTENT_TRIANGLE'].astype(np.int64)
    sphere = gii(D + f'sphere_{h}.gii.gz')['NIFTI_INTENT_POINTSET'].astype(np.float64)
    sulc = gii(D + f'sulc_{h}.gii.gz')['NIFTI_INTENT_SHAPE'].astype(np.float64)
    n_cur = len(pial)
    while n_cur > N:
        F, n_cur = coarsen(F, n_cur)
    assert n_cur == N and F.max() == N - 1, (n_cur, F.max())
    # winding: face normal on the sphere must point away from the centre
    sp = sphere[:N]
    nrm = np.cross(sp[F[:, 1]] - sp[F[:, 0]], sp[F[:, 2]] - sp[F[:, 0]])
    flip = (nrm * (sp[F[:, 0]] + sp[F[:, 1]] + sp[F[:, 2]])).sum(1) < 0
    F[flip] = F[flip][:, ::-1]
    hemis[h] = (pial[:N], F, sulc[:N])

# the same top-view projection as brainbake/bake.py: screen x = x, screen y = -y (anterior up), z toward viewer
allp = np.vstack([hemis[h][0] for h in hemis])
mn, mx = allp.min(0), allp.max(0)
sc_img = min(IMG_W * .96 / (mx[0] - mn[0]), IMG_H * .96 / (mx[1] - mn[1]))
f_mask = sc_img * MASK_W / IMG_W
c = (mn + mx) / 2
P = lambda v: np.column_stack([(v[:, 0] - c[0]) * f_mask, (v[:, 1] - c[1]) * f_mask, (v[:, 2] - c[2]) * f_mask])

verts, norms, sulcs, tris, n_left = [], [], [], [], 0
for k, h in enumerate(('left', 'right')):
    v, f, s = hemis[h]; v = P(v)
    nrm = vnormals(v, f)
    base = sum(len(x) for x in verts)
    verts.append(v); norms.append(nrm); sulcs.append(s); tris.append(f)  # indices stay local to each hemisphere so u16 is enough (WebGL1 has no base vertex)
    if k == 0: n_left = len(v)
assert len(tris[0]) == len(tris[1])
V = np.vstack(verts); Nn = np.vstack(norms); S = np.concatenate(sulcs); T = np.vstack(tris)
POS_SCALE = 40.0
pos = np.round(V * POS_SCALE).astype(np.int16)
assert np.abs(V * POS_SCALE).max() < 32000
sul = np.clip((S - S.min()) / (np.percentile(S, 99.5) - S.min()) * 255, 0, 255).astype(np.uint8)
with open(OUT, 'wb') as fh:
    fh.write(struct.pack('<4sIIfI', b'BRN1', len(V), len(T), POS_SCALE, n_left))
    fh.write(pos.tobytes()); fh.write(np.round(Nn * 127).astype(np.int8).tobytes())
    fh.write(sul.tobytes()); fh.write(T.astype(np.uint16).tobytes())
print('verts', len(V), 'tris', len(T), 'left verts', n_left)
print('extent X', V[:, 0].min(), V[:, 0].max(), 'Y', V[:, 1].min(), V[:, 1].max(), 'Z', V[:, 2].min(), V[:, 2].max())
