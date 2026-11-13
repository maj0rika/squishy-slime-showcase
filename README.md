# Squish — XPBD 소프트바디 말랑이 쇼케이스 (v7)

three.js r170 / WebGL2 기반의 단일 페이지 인터랙티브 소프트바디 쇼케이스입니다.
투명한 젤리가 아니라 **불투명한 말랑이(스퀴시) 장난감**을 목표로 합니다. 표면을 잡아 늘리고,
꾹 눌러 옆으로 퍼트리고, 접어서 반죽하고, 물감을 넣어 색을 섞을 수 있습니다.

v7은 "진짜 장난감을 만지는 느낌"을 위해 촉각을 만드는 근원을 고쳤습니다.

- **손가락은 힘(force)입니다** — 스크립트된 덴트·홀드 싱크 오프셋을 없애고, 포인터가 표면 법선
  방향으로 힘을 가합니다. 얼마나 파고드는지는 재질이 정합니다(말랑이는 깊게, 탱탱볼은 얕게).
  제자리에 꾹 누르면 힘이 커지고, 끌면 힘이 줄어들며 핀(pin)이 이어받아 패치가 늘어납니다.
- **실제 스케일과 시간** — 1 시뮬레이션 단위 = **3.6 cm**, 시뮬레이션 시간은 벽시계의 3배
  (`simulation.timeScale`)입니다. 고정 서브스텝은 `1/180 s`, 60 fps 한 프레임은 9 서브스텝입니다.
- **소리와 보이는 손가락** — 첫 터치에서 잠금 해제되는 사운드와, 마우스/펜 입력을 위한 보이는
  손가락 프록시를 추가했습니다.
- **살아있는 재질** — 복귀를 죽이던 과한 댐퍼(`viscoRelease 200`)를 없애고, 재질이 실제로
  출렁이며 복귀합니다.

v4의 무제한 멀티터치·촉감 완성도·빛/질감/표면은 그대로 유지합니다.
v3의 볼류메트릭 XPBD 모델(그리드 사면체화 + 변/부피 제약 + 표면 스키닝), 자기충돌·용접(반죽),
색장(마블링), 렌더 모드 전환도 그대로 유지합니다.

빌드 도구는 없습니다. 정적 파일을 HTTP로 서빙하면 그대로 실행됩니다.

---

## 1. 실행 방법

```bash
cd squishy-slime-showcase
python3 -m http.server 4173
```

브라우저에서 <http://localhost:4173> 을 엽니다.

- ES module + importmap을 쓰기 때문에 `file://`로 직접 열면 동작하지 않습니다. 반드시 HTTP 서버가 필요합니다.
- three.js r170은 jsDelivr CDN에서, 폰트(Pretendard / Instrument Serif / JetBrains Mono)는 CDN에서,
  스튜디오 HDRI는 Poly Haven CDN(`dl.polyhaven.org`, CC0)에서 받습니다. **네트워크 연결이 필요합니다.**
  three.js가 실패하면 화면이 뜨지 않고, HDRI가 실패하면 상태 pill에 `조명 로드 실패`와 원본 에러가
  표시된 뒤 예외가 다시 던져집니다(대체 환경 없음).
- WebGL2를 사용할 수 없는 환경에서는 캔버스 대신 안내 화면이 표시됩니다.
- 노드가 있으면 물리만 따로 검증할 수 있습니다: `node tests/physics.smoke.mjs`.

---

## 2. 조작

**도구 독은 없습니다.** 모든 조작은 말랑이 위에서의 제스처로 이어집니다.

| 입력 | 조작 | 결과 |
| --- | --- | --- |
| 왼쪽 드래그 / 한 손가락 | 말랑이를 잡고 위·바깥으로 끌기 | 잡은 패치가 늘어나고 주변까지 끌려옴(스트레치) |
| 왼쪽 드래그 / 한 손가락 | 말랑이를 잡고 아래로 끌기 | 패치가 아래로 끌려가고 부피가 보존되어 옆으로 퍼짐(스쿼시) |
| 왼쪽 드래그 / 한 손가락 | 표면을 누르기(제자리에서 꾹 누르면 더 깊이) | 손가락이 법선 방향으로 힘을 가해 재질이 파고듦(포스 푸시) |
| 여러 손가락 (터치) | 말랑이 여러 곳을 동시에 잡기 | 여러 손으로 늘리기·접기·반죽 (최대 `grab.maxHands` = 10손) |
| 오른쪽 드래그 / Shift + 왼쪽 | 말랑이 위에서 아래로 | 손바닥 프레스(부피가 옆으로 퍼짐) |
| — | 빈 곳 한 손가락 드래그 | 카메라 회전(Orbit) |
| — | 빈 곳 두 손가락 핀치 / 휠 | 확대·축소 |
| — | 더블 클릭 | 기본 카메라 구도로 복귀 |

제스처가 하나로 이어지는 방식:

- 잡은 지점을 통과하는 **카메라 정면 평면** 위에서 포인터를 움직입니다. 위·바깥 = 늘리기, 아래 = 끌어내리기.
- 포인터는 표면 법선 방향으로 **힘**을 가합니다(`touch` 항 + 홀드 항 + 접촉 면적 항). 표면이 얼마나
  파고드는지는 스크립트된 오프셋이 아니라 **재질**이 정합니다. 제자리에서 꾹 누르면(움직임 6px 미만,
  0.15초 이후) 힘이 `holdMax`까지 커지고, 12px 넘게 끌면 그 손의 힘 성장이 멈춥니다. 끄는 동안에는
  힘이 `exp(-drag / pullDecay)`로 줄어들며 핀(pin)이 패치를 목표점으로 끌고 갑니다.
- **손가락 개수 제한이 없습니다.** 말랑이에 닿는 포인터마다 손(hand)이 하나씩 생기고, 손마다 독립적인
  힘·목표·깊이 상태를 가집니다. 활성 손이 `grab.maxHands`(10)에 도달하면 그 뒤 포인터는 무시됩니다.
- 손이 하나라도 활성이면 빈 곳에 닿은 손가락은 무시됩니다. **OrbitControls는 완전히 꺼집니다.**
  모두 놓으면 다시 켜집니다.
- 일시정지 중에는 손을 잡을 수 없고 회전만 됩니다. `pointerup` / `pointercancel` / 창 포커스 상실 /
  탭 숨김 시 해당 손(또는 모든 손)이 정리됩니다.
- 커서: 말랑이 위 = `grab`, 손이 활성 중 = `grabbing`.
- **햅틱(진동)** — `navigator.vibrate`가 있는 하드웨어(주로 Android; iOS는 없음)에서만 동작합니다.
  잡기 시작 시 8ms, 드래그가 0.25 월드 단위를 넘을 때마다 4ms, 손바닥 프레스 시작 시 `[0, 12]` 패턴을
  울립니다. API가 없으면 아예 호출하지 않습니다.

### 색 · 물감

- **몸 색** — 패널 `색` 섹션의 스와치. 몸 전체 색을 한 번에 바꿉니다(마블링 초기화).
- **물감** — `물감` 줄의 스와치(레몬·민트·체리 포함). 누르면 **카메라를 향한 윗면 정점** 중 하나에
  반경 0.55로 물감 한 방울이 얹히고 살짝 눌려 들어갑니다. **주무르면 색이 점차 섞입니다.**
- `초기화`는 모양과 함께 색도 현재 몸 색으로 되돌립니다.

패널(컨트롤)의 동작:

| 버튼 | 결과 |
| --- | --- |
| 초기화 | 손 취소, 변형 리셋(위에서 떨어뜨림), 색 초기화, 슬라이더를 기본값으로, 촉감 프리셋을 `말랑이`로, 시점 복귀 |
| 일시정지 / 재개 | 물리 시뮬레이션 정지/재개 (카메라 조작은 계속 가능) |
| 소리 켜짐 / 꺼짐 | 모든 사운드를 음소거/해제(마스터 게인 30ms 램프). 상태는 `localStorage['squish.sound']`에 저장 |
| 톡 찌르기 | 카메라를 향한 윗면 정점 하나를 현재 위치에서 한 번 찌름 |
| 떨어뜨리기 | 현재 모양 그대로 위로 들어 올렸다가 다시 떨어뜨림(첨벙) |

---

## 3. 물리 모델 요약

`src/physics/softBody.js`는 three.js에 의존하지 않는 순수 JS XPBD 솔버입니다(Node에서 테스트 가능).
말랑이는 속이 빈 껍질이 아니라 **속이 채워진 입체**입니다. 닫힌 표면을 그리드로 채워 사면체 메시를 만들고,
그 사면체를 XPBD 제약으로 풀면서 매끄러운 표면을 사면체에 박아(스키닝) 그립니다. 고정 서브스텝
(`CONFIG.simulation.fixedDt`, `1/180 s`)마다 아래를 순서대로 한 번씩 풉니다. 시간 규약은
**시뮬레이션 시간 = 벽시계 시간 × `simulation.timeScale`(3)** 입니다. `body.step(h)`와
`body.updateDerived(dt)`는 시뮬레이션 초를 받습니다(60 fps 한 프레임 = 9 서브스텝).

1. **예측**: 감쇠와 중력으로 속도를 갱신하고 위치를 예측.
2. **거리 제약** (`solveEdges`): 사면체의 모든 변에 XPBD 거리 제약. `edgeCompliance`로 강성 조절.
3. **사면체 부피 제약** (`solveVolumes`): 각 사면체의 부피를 rest 부피로 유지(비압축). 그래서 누르면 옆으로 퍼집니다.
4. **잡기/누르기**: 여러 손(최대 `grab.maxHands`)이 각자 법선 방향 힘을 가하고(포스 푸시), 핀 제약이
   패치를 목표점으로 끌고 갑니다. 누르는 동안에는 핀의 법선 성분이 풀려 재질이 파고들고, 끌면 핀이 이어받습니다.
5. **바닥/경계** (`solveFloorAndBounds`): 바닥 관통 방지 + 끈적한 마찰, 천장/반경 클램프.

제약을 모두 푼 뒤 속도를 위치 차분으로 갱신하고 속도 상한/점성 감쇠를 적용합니다. `plasticRate > 0`이면
**소성 변형**(변 rest 길이를 현재 길이 쪽으로 천천히 이동)을 적용해, 복원력이 낮을 때(슬라임) 변형이 그대로 남습니다.
한편 `shapeRate > 0`(복원력이 높은 탄성 프리셋)이면 **전역 노드 형상 매칭**(Müller)이 동작합니다.
손·프레스가 없는 **유휴 상태에서만** 적용되고, 목표는 소성의 영향을 받지 않는 **정착된(중력으로 바닥에
눌린) 형상**이라 중력과 싸우지 않습니다. `shapeRate`는 `recovery`에서 나오며, 소성 프리셋(슬라임)은
`shapeRate = 0`이라 형상 기억이 없습니다. **손을 놓는 순간 형상 매칭이 급격히 세지지 않습니다** — 예전의
`idleShapeBoost`(놓는 순간 14배)는 제거했고, 마지막 손/프레스가 풀린 뒤 `CONFIG.feel.shapeRampSeconds`
(0.35 s) 동안 유효 형상 매칭률이 0 → `shapeRate`로 **선형으로 되살아납니다.** 그래서 말랑이는 튕기지
않고 부드럽게 제자리로 돌아옵니다.

### 자기충돌과 합쳐짐(반죽)

- **경계 노드**(내부 격자 노드보다 사면체에 덜 속한 노드)만 충돌합니다.
- 매 2번째 서브스텝마다 경계 노드를 공간 해시로 훑어, 현재 거리가 `collideFactor × spacing`보다 가깝고
  **재료상 멀리 떨어진**(rest 거리 > `restFar × spacing`) 쌍을 서로 밀어냅니다 — 겹친 부분이 서로를 통과하지 못합니다.
- `params.fuse > 0`이면 그런 쌍을 **용접(weld)** 합니다: 현재 거리를 rest로 하는 거리 제약을 추가하고,
  변 제약 뒤에 함께 풉니다. `weldBreak × weldRest`보다 길어지면 끊어지고, `plasticRate > 0`이면
  용접 rest도 변처럼 소성으로 늘어납니다.
  - 말랑이: 임시로 붙었다가(용접 파괴 1.35) 놓으면 떨어짐.
  - 슬라임: 영구 융합(파괴 4.0, 소성) — 접은 자리가 한 덩어리로 남음.
  - 탱탱볼: `fuse 0` — 붙지 않음.
- 소성이 없는 프리셋(`plasticRate === 0`)의 용접은 **수명**이 있습니다. 손·프레스가 없을 때(유휴)
  `weldLife`초가 지나면 제거되어, 탄성 변 제약이 몸을 원래 형상으로 되돌립니다(말랑이 `weldLife 0.5`).
  소성 프리셋(슬라임)은 `weldLife 1e9`로 사실상 만료되지 않습니다.

### 색장(마블링)

- `nodeColor`(사면체 노드 색)와 `surfaceColor`(표면 정점 색)는 선형 RGB입니다.
  표면 색은 임베딩의 무게중심 좌표로 노드 색을 보간해 채웁니다(색이 바뀔 때만).
- `setBaseColor(rgb)`는 몸 전체 색을, `paintColor(point, radius, rgb)`는 한 지점 주변을 물들입니다.
- 프레임마다 변·용접의 **변형률 속도**(`|L − Lprev| / rest / dt`)에 비례해 양 끝 색을 평균 쪽으로
  조금씩 이동시킵니다. 변은 `edgeMix`, 용접은 `weldMix`가 비율을 정합니다. 활동량이
  `mixActivityFloor` 이하인(정지한) 몸은 섞이지 않고, 늘리고 접을수록 마블링이 생기다 점차 균일해집니다.

### 렌더 모드

- **매끈 표면(skinned)** — 사면체에 박은 매끄러운 표면을 그대로 그림(기본, 말랑이/탱탱볼).
- **슬라임 표면(implicit)** — 노드에서 밀도/색 장을 만들어 마칭 큐브로 표면을 다시 그립니다. 각 노드를
  삼선형(trilinear)으로 밀도·색 그리드에 적재한 뒤, 축별 3회 분리 박스 블러(separable box blur)로
  평활화해 접힌 자리가 눈에 보이게 합쳐집니다. 해상도는 `CONFIG.render.implicitResolution`
  (데스크톱 40, 모바일 28)에서 옵니다. `plasticRate > 0`(슬라임처럼 소성이 있는) 설정에서 자동
  선택됩니다. 레이캐스트 대상은 항상 매끈 표면입니다.

### 조명 · 재질 · 포스트프로세싱 (v4 · v6)

빛과 표면을 사진처럼 만들기 위해 실제 방 환경(HDRI)과 후처리를 씁니다.

- **실제 방 환경(HDRI)** — Poly Haven의 `lebombo`(**CC0 라이선스**)를 `RGBELoader`로 읽어
  `texture.mapping = EquirectangularReflectionMapping`으로 둡니다(데스크톱 `lebombo_2k.hdr`, 모바일
  `lebombo_1k.hdr`). 원본 텍스처를 `GroundedSkybox`로 지면 투영한 스카이박스(`GROUND_HEIGHT = 18`,
  `GROUND_RADIUS = 160`, `skybox.position.y = GROUND_HEIGHT − 0.01`)로 장면에 넣고, 같은 텍스처를
  `PMREMGenerator`로 `scene.environment`에 넣습니다. 회전은 스카이박스와 환경광이 항상 같은 값이 되도록
  단일 `setEnvironmentRotation(y)`로만 바꾸며 기본값은 `ENV_ROTATION_Y = 0`입니다. 종이 바닥 메시·바닥
  텍스처·`scene.fog`·`scene.background` 색은 제거했습니다(배경은 스카이박스 자체입니다). 헤미스피어/림
  라이트는 없고 그림자용 방향광 키 하나만 남겼습니다(`KEY_OFFSET`, VSM). HDR 로딩이 끝날 때까지 화면을
  그리지 않으며, 실패하면 원본 에러를 상태 pill에 표시한 뒤 그대로 다시 던집니다(**대체 환경 없음**).
- **그림자 캐처** — `PlaneGeometry(60, 60)`을 y = 0.001에 두고 `ShadowMaterial`(`SHADOW_OPACITY = 0.45`)로
  키의 그림자만 받아 오브젝트를 바닥에 붙입니다. 접촉 그림자 평면(진한 접촉선)은 그대로 유지합니다.
- **포스트프로세싱** — `EffectComposer`(HalfFloat, 데스크톱 MSAA 4 / 모바일 0) → `RenderPass` →
  `OutputPass` → 필름 `ShaderPass`(비네트, 미세한 애니메이션 그레인 0.012). 톤매핑은
  `NeutralToneMapping`, 노출 `EXPOSURE`.
- **말랑이 재질** — `MeshPhysicalMaterial` + `onBeforeCompile`. rest 공간 3D 노이즈로 모공(웍슬)과
  그레인(fbm) 높이를 만들어 화면공간 도함수로 범프를 주고, 거칠기·알베도를 미세하게 흔듭니다.
  늘어난 얇은 부분(`surfaceStretch`)은 밝아지고 반투명해지며(SSS), 압축된 부분은 채도가 깊어집니다.
  프로필 `mochi`(모찌 실리콘).
- **슬라임 재질** — `createSlimeMaterial`: 젖은 광택(거칠기 0.07, 클리어코트 1.0) + 더 강한 SSS,
  모공 없이 아주 약한 월드 노이즈 범프만. 암시적(implicit) 표면이 이 재질을 씁니다.
- **품질 티어** — 데스크톱/모바일은 **명시적 설정**입니다(폴백 아님). 모바일은 MSAA를 끄고 그림자 맵·
  마칭큐브 해상도를 낮추며, HDRI도 1k로 받습니다.

표면은 `skin()`이 매 프레임 사면체 노드 위치를 **무게중심 좌표(barycentric)** 로 보간해 채웁니다
(`body.pos`는 수명 동안 같은 `Float32Array`). 그 뒤 **표면 변위 평활화**(이웃 변위 평균으로 Jacobi)를
적용해, 거친 사면체가 만드는 각진 자국을 시각적으로 완화합니다. 이어서 `updateDerived(dt)`가 centroid /
bounds / contact / 에너지를 갱신하고 NaN을 감시합니다. 표면 거칠기는 **메시 전체**(제외 구역 없음)에 대해
이산 라플라시안 크기 변화로 측정합니다.

사면체화는 `src/physics/tetrahedralize.js`가 담당합니다.

- 표면 bbox를 그리드로 나누고, 광선 홀짝(ray parity, Möller–Trumbore) 내부 판정으로 셀을 유지합니다.
- 유지된 셀마다 6개의 Kuhn 사면체를 만듭니다. rest 부피가 0 이하이면 즉시 예외를 던집니다.
- 각 표면 정점을 셀의 사면체 중 하나에 무게중심 좌표로 임베딩합니다. 최소 무게중심이 음수면 예외를 던집니다.

메시 자체는 `src/physics/topology.js`가 검증합니다.

- 모든 무향 변이 **정확히 두 삼각형**에 쓰여야 함(닫힌 2-매니폴드, 이음선 없음),
- `정점 − 변 + 삼각형 = 2` (구의 오일러 지표).

둘 중 하나라도 어긋나면 즉시 예외를 던집니다.

바닥 접촉은 **끈적합니다**. 말랑이는 책상에 살짝 붙어 있어서(정적 마찰) 가볍게 당기면 늘어나다가,
충분히 세게 당기면 떨어져 나옵니다. 그래서 옆으로 당겨도 바닥이 붙잡아 주어 몸통이 밀리지 않고
늘어납니다. 끈적임 정도는 `tack` 값(말랑이 1.0 / 슬로우 1.2 / 슬라임 1.6 / 탱탱볼 0.45)이 정합니다.

슬라이더 매핑은 `src/physics/presets.js`의 `resolvePhysics()`에 있습니다.

- **단단함 (firmness)** — 사면체 변 제약의 컴플라이언스(로그 보간; 작을수록 잘 늘어남).
- **복원력 (recovery)** — 소성률(`plasticRate`)과 전역 형상 매칭률(`shapeRate`). 낮으면 슬라임처럼 변형 유지,
  높으면 탱탱볼처럼 정착 형상으로 복원.
- **감쇠 (damping)** — 선형 감쇠(`linearDamping`)과 변 점성(`viscosity`).

`FEEL_PRESETS`는 네 가지(칩 순서)입니다: **말랑이 / 슬로우 / 슬라임 / 탱탱볼**. 각 프리셋은 슬라이더
세 값(단단함·복원력·감쇠)과 **숨은 값**(`tack`, `fuse`, `weldBreak`, 색 섞임 비율, `weldLife`,
`viscoRelease`, `shapeRate`)의 묶음입니다. 숨은 값은 슬라이더로 노출되지 않고, 프리셋을 고르면 함께
적용됩니다. 슬라이더를 움직이면 프리셋 선택만 해제되고 현재 숨은 값은 그대로 유지됩니다. 초기화는
형태 기본값으로 되돌립니다. 촉감 프리셋은 사운드 재질도 함께 바꿉니다(슬라이더만 움직이면 마지막
재질을 유지).

릴리즈 곡선(정착 후 꼭대기를 +1.0 늘렸다 놓고 `maxY`를 샘플)의 v7 측정 기준 — **모든 시간은 실제(벽시계) 초**:

| 프리셋 | 릴리스 언더슈트(끌어올림 대비) | 영점 교차 | 조용해지는 시간 | 낙하 최소 높이 / 정착 | 첫 접촉까지 |
| --- | --- | --- | --- | --- | --- |
| 말랑이 | 10–30 % | 2–5 | ≤ 0.45 s | 0.80–0.90 | 0.08–0.13 s |
| 슬로우 | ≤ 2 % | 0–1 | t50 0.6–1.5 s, 6 s 내 정착 | 0.90–0.99 | 0.08–0.14 s |
| 탱탱볼 | 15–35 % | 2–6 | ≤ 0.35 s | 0.84–0.94 | 0.08–0.13 s |
| 슬라임 | 형상 유지(소성 테스트) | — | — | 0.82–0.93 | 0.08–0.13 s |

모든 프리셋에서 정착 높이 ≥ 0.90 × 1.66, 부피 유지율 0.97–1.03, 뒤집힌 사면체 0을 유지합니다.
손바닥 프레스 곡선(`press-curve-말랑이` / `press-curve-슬로우`)도 같은 창을 씁니다. `idleShapeBoost`는
제거했고, 복원은 `shapeRampSeconds`(0.35 s) 동안 형상 매칭률이 선형으로 되살아나는 방식입니다.

### 소리

- `src/audio/squishAudio.js`의 `SquishAudio`가 Web Audio 그래프를 만듭니다. 각 원샷은
  `AudioBufferSourceNode → BiquadFilterNode(로우패스) → GainNode → 마스터 GainNode(0.6) →
  DynamicsCompressorNode → destination`을 거칩니다.
- **첫 터치에서 잠금 해제** — 스테이지의 첫 `pointerdown`에서 `unlock()`이 `AudioContext`를 만들고
  `resume()`한 뒤 24개 파일(`squish_01..06`, `pop`, `splat`, `slime_01..16`)을 받아 디코드합니다.
  실패하면 상태 pill에 `소리 로드 실패 · <원본 에러>`를 표시하고 그대로 다시 던집니다(대체 없음).
- 이벤트: 터치(`grabStart`), 파고들 때의 스퀄치(`signals.depthRate` 적산), 늘어남(`dragTravel` 적산),
  충돌(`signals.impact > 3`), 깊은 누름의 해제(`grabEnd(depth)`), 박리(`signals.weldBreaks`). 슬라임은
  젖고 크게, 말랑이/슬로우/탱탱볼은 거의 무음에 가깝게 뭉개진 소리를 냅니다. 한 번에 최대 6개 원샷,
  같은 종류끼리 최소 70 ms 간격.
- 패널의 `소리` 버튼은 마스터 게인을 30 ms 동안 램프해 음소거/해제합니다. 상태는
  `localStorage['squish.sound']`(`'on'`/`'off'`)에 저장됩니다.
- 소리 출처는 `assets/audio/CREDITS.md`(모두 CC0)에 있습니다.

### 보이는 손가락

- `src/render/fingerProxy.js`의 `FingerProxy`가 마우스/펜 입력용 손가락 끝을 그립니다(터치 사용자는
  실제 손가락이 이미 있으므로 그리지 않습니다). `CapsuleGeometry` 하나가 손가락마다 있고, 끝 구가
  솔버의 접촉 중심 `center + normal × 0.2`에 닿습니다. 축은 뷰어의 오른쪽 아래를 향하고, 손가락이
  몸 안으로 들어가지 않도록 법선과의 최소 각을 지킵니다.
- 나타남/사라짐은 90 ms / 120 ms 스케일 이즈, 위치는 25 ms 임계 감쇠 평활화를 씁니다. 손가락이
  말랑이에 드리우는 그림자가 주된 접촉 단서입니다(`castShadow = true`).

---

## 4. 파일 구조

```
index.html                  마크업, importmap, 마스트헤드, 힌트, WebGL2 폴백
styles.css                  에디토리얼 레이아웃 / 힌트 / 패널 / 반응형
README.md
tests/physics.smoke.mjs     Node 전용 물리 스모크 테스트 (three.js 불필요)

src/main.js                 부트스트랩, WebGL2 지원 확인, stage.ready 대기, window.__squishApp 노출
src/app.js                  전체 조립, 고정 타임스텝 루프, 상태, 제스처/색/렌더모드/디버그 배선
src/config.js               앱 전역 튜닝값(고정 dt, 그랩/프레스/반죽, 촉감 램프, 카메라, 렌더, 기본값)

src/shapes/registry.js      ShapeDefinition 등록/조회
src/shapes/index.js         형태 등록 지점 (Slime 하나)
src/shapes/slime.js         Slime 형태 정의(물리·재질·색·카메라 기본값)
src/shapes/icosphere.js     닫힌 icosphere 생성 + 푸딩 실루엣 프로파일

src/physics/topology.js      표면 변/삼각형 위상 구축 + 2-매니폴드 검증
src/physics/tetrahedralize.js 그리드 사면체화(Kuhn 6-tet) + 광선 홀짝 내부 판정 + 표면 임베딩
src/physics/softBody.js      XPBD 볼류메트릭 솔버 + 자기충돌/용접 + 색장 + 무게중심 스키닝
src/physics/presets.js       FEEL_PRESETS + 슬라이더 값 → 솔버 계수 매핑

src/render/stage.js         렌더러, 지면 투영 HDRI 스카이박스, 그림자 캐처, 키 라이트/VSM, 포스트프로세싱, 접촉 그림자
src/render/materials.js     색상/물감 프리셋 + 말랑이/슬라임 재질 + 미세 범프/SSS + 정점 색
src/render/surface.js       시뮬레이션 버퍼 ↔ GPU 정점 버퍼, 노멀 재계산, 바운드 갱신
src/render/implicitSurface.js 슬라임 표면(마칭 큐브) + 렌더 모드 선택
src/render/fingerProxy.js   마우스/펜용 보이는 손가락(캡슐·그림자·이즈)

src/audio/squishAudio.js    Web Audio 그래프(터치·스쿼시·늘어남·충돌·팝·박리), 첫 터치에서 잠금 해제
assets/audio/*.mp3          squish_01..06 / pop / splat / slime_01..16 (CC0)
assets/audio/CREDITS.md     사운드 출처

src/input/camera.js         OrbitControls 래퍼, 형태 기반 프레이밍, 더블클릭 복귀 트윈, centroid 추적
src/input/pointer.js        제스처 입력(포스 푸시·누르기·무제한 멀티터치·햅틱), 레이캐스트, 카메라 조작과의 중재

src/ui/panel.js             패널 DOM 생성/바인딩(색·물감·촉감·동작·메모·디버그), 통계 표시
src/ui/debug.js             와이어프레임·제어점·바닥 접촉·잡기 범위·용접 오버레이
```

### 데이터 흐름

```
requestAnimationFrame
  → pointer.update(dt)                      활성 손들의 힘·목표 갱신 (dt는 실제 초)
  → body.step(fixedDt) × N (최대 maxSubsteps)  누적기 += dt × timeScale, 고정 타임스텝 서브스텝
  → body.updateDerived(steps × fixedDt)     스키닝 + 색장 섞기 + 변위 평활화 + centroid/bounds/contact/에너지 + signals
  → surface.sync()                          body.pos/색을 GPU 버퍼로, 필요할 때만 노멀 재계산
  → implicit.sync()                         렌더 모드가 슬라임일 때만
  → rig.follow(centroid, dt) + rig.update() 손이 없을 때 시점이 centroid를 따라감
  → stage.update({ centroid, contact, dt }) 접촉 그림자 반응
  → audio.update({ dt, signals, dragTravel })  소리(누적기는 실제 초, 신호는 시뮬레이션 단위)
  → fingerProxy.update({ fingers, camera, dt }) 보이는 손가락 배치/이즈
  → stage.render(camera)
```

`body.pos`(`Float32Array`)와 `body.surfaceColor`를 `BufferAttribute`로 **그대로** GPU에 연결합니다.
별도의 보간·복사 레이어는 없습니다. 유일한 시각적 처리는 표면 변위 평활화입니다.

---

## 5. 수치를 고치는 위치

| 바꾸고 싶은 것 | 위치 |
| --- | --- |
| 색상 팔레트 / 물감 팔레트 / 한국어 이름 | `src/render/materials.js` → `COLOR_PRESETS`, `PAINT_PRESETS` |
| 재질 프로필(거칠기, 클리어코트, sheen, SSS) | `src/render/materials.js` → `MATERIAL_PROFILES`, `onBeforeCompile` |
| 촉감 프리셋(숨은 `tack`/`fuse`/`weldBreak`/`edgeMix`/`weldMix`/`weldLife`/`viscoRelease`) / 슬라이더 → 제약 컴플라이언스 | `src/physics/presets.js` → `FEEL_PRESETS`, `resolvePhysics()` |
| 형태별 기본 물리/색/카메라 | `src/shapes/slime.js` |
| 실루엣(푸딩 프로파일) | `src/shapes/icosphere.js` → 프로파일 맵 |
| 표면 해상도 | `src/shapes/icosphere.js` → `pickDetail()` (데스크톱 23, 저사양 15) |
| 사면체 그리드 간격 | `src/shapes/icosphere.js` → `pickSpacing()` (데스크톱 0.17, 저사양 0.24) |
| 고정 타임스텝 / 서브스텝 / 중력 / 경계 / 낙하 높이 | `src/config.js` → `simulation` |
| 잡기 반경 / 최대 드래그 / **포스 푸시**(터치·홀드·접촉 면적·최대 힘·감쇠) | `src/config.js` → `grab.pull` (`push`: `touch`, `touchEaseSeconds`, `holdStartSeconds`, `holdPerSecond`, `holdMax`, `areaGain`, `max`, `pullDecay`, `freeForce`) |
| 동시에 잡을 수 있는 손 수(무제한 멀티터치 상한) | `src/config.js` → `grab.maxHands` (10) |
| 누르기 깊이 | `src/config.js` → `grab.press` |
| 자기충돌/용접(반죽) 거리·한계 | `src/config.js` → `knead` (`collideFactor`, `restFar`, `maxWelds`) |
| 손을 놓은 뒤 형상 기억이 되살아나는 시간 | `src/config.js` → `feel.shapeRampSeconds` (0.35) |
| 슬라임 표면(마칭 큐브) 해상도 | `src/config.js` → `render.implicitResolution` (데스크톱 40 / 모바일 28) |
| 카메라 FOV / 거리 / 각도 제한 / 추적 속도 | `src/config.js` → `camera`, `src/shapes/slime.js` → `camera` |
| 사운드 그래프 / 원샷 상한 / 이벤트 매핑 | `src/audio/squishAudio.js` |
| 보이는 손가락 외형(캡슐·재질·이즈) | `src/render/fingerProxy.js` |
| 조명 / 스카이박스 / 그림자 캐처 / 접촉 그림자 | `src/render/stage.js` |
| HDRI 소스 / 지면 투영 / 환경 회전 / 노출 / 톤매핑 | `src/render/stage.js` (`GROUND_HEIGHT`, `GROUND_RADIUS`, `ENV_ROTATION_Y`, `EXPOSURE`, Neutral) |
| 포스트프로세싱(그레인 · 비네트) | `src/render/stage.js` |
| 미세 표면 범프 / SSS / 늘어남 셰이딩 | `src/render/materials.js` |
| UI 문구 | `index.html`, `src/ui/panel.js` |

---

## 6. 새로운 형태 추가 절차

1. `src/shapes/<id>.js` 에 ShapeDefinition 객체를 만듭니다.

```js
export const heartShape = {
  id: 'heart',
  name: 'Heart',
  build({ detail, spacing } = {}) {
    // 반환: { geometry, rest, index, vertexCount, floorY, spacing, bounds }
    // geometry 는 반드시 indexed 이고 닫힌 2-매니폴드여야 합니다.
  },
  physics: { firmness: 0.5, recovery: 0.4, damping: 0.4, tack: 1.0, fuse: 1, weldBreak: 1.35, edgeMix: 0.015, weldMix: 0.25, weldLife: 0.5, viscoRelease: 0 },
  material: 'mochi',
  color: 'strawberry',
  camera: { target: [0, 0.8, 0], azimuth: 0.34, polar: 1.24, radius: 1.2, margin: 1.05 },
};
```

2. `src/shapes/index.js` 에서 `registerShape(heartShape)` 를 호출합니다.

**주의할 점**

- 공통 솔버는 **닫힌 2-매니폴드 인덱스 메시**를 전제로 합니다. 속은 그리드로 자동 사면체화되고
  (`spacing` 간격), 매끄러운 표면은 그 사면체에 무게중심 좌표로 임베딩되어 스키닝됩니다. 여러 파트가
  붙은 캐릭터(예: 몸통 + 분리된 귀)는 자동으로 지원되지 않습니다.
- `build()`가 반환하는 `index`는 `geometry.index.array`의 `Uint32Array` 복사본이어야 합니다.
- `build()`는 `spacing`(사면체 그리드 간격)도 반환해야 합니다. 표면이 닫혀 있지 않거나 사면체 임베딩에
  실패하면 `tetrahedralize()`가 예외를 던집니다.
- `physics`에는 슬라이더 세 값과 촉감 프리셋이 정의하는 **숨은 값**(예: `tack`/`fuse`/`weldBreak`/
  색 섞임 비율/`weldLife`/`viscoRelease`)이 모두 있어야 합니다. `resolvePhysics()`는 값이 하나라도
  없거나 유한하지 않으면 예외를 던집니다.
- `floorY` 는 바닥 접촉 평면입니다. 형태의 최저점이 `floorY` 에 오도록 정렬해야 바닥을 뚫지 않습니다.
- v4 UI에는 형태 선택 섹션이 없습니다. 형태를 여러 개 등록하려면 `src/app.js` 에 전환 UI를 추가해야 합니다.

---

## 7. 의도적으로 구현하지 않은 것

- **비틀기(twist)** — 입력이 늘리기/누르기와 충돌할 위험이 있어 제외했습니다.
- **재질 선택 UI** — 재질 프로필 1종(`mochi`)만 제공하므로 선택 UI를 노출하지 않습니다(구조는 준비됨).
- **다중 형태 기본 제공 / 형태 선택 UI** — Slime 완성도를 우선했습니다.
- 투명/굴절/내부 발광/블룸
- 액체처럼 흐르는 거동, WebGPU
- 키보드만으로 오브젝트를 변형하는 조작 (슬라이더·버튼은 키보드 접근 가능)

---

## 8. 테스트

`tests/physics.smoke.mjs`는 three.js 없이 물리 코어만 검증합니다(두 가지 해상도: n = 24, spacing 0.17 /
n = 16, spacing 0.24). 모든 시나리오 시간은 **실제(벽시계) 초**이고, 테스트는 `FRAME = 1/60 s`,
`SUBSTEPS = round(FRAME × timeScale / fixedDt)`(= 9)로 진행하며 `updateDerived`에는 시뮬레이션 초를
넘깁니다. 매 프레임 뒤집힌 사면체 0, 유한 좌표, 메시 전체 거칠기 임계값(roughP99 ≤ 0.15, roughMax ≤ 0.45)을
확인합니다.

- **사면체화**: 모든 rest 부피 > 0, 표면 위상 검증(닫힌 2-매니폴드), 노드/사면체/변 수 출력.
- **유휴 드리프트**: 정착 1 s 뒤 손 없이 10 s 동안 수평 중심 이동 ≤ 0.01(격자 이방성 크립 회귀 방지).
- **정착 / 늘리기 / 매달기 / 낙하 첨벙 / 비중심 프레스 / 옆으로 당기기**.
- **포스 푸시**: 정착한 몸 위에 상수 힘을 주고 1.5 s 뒤 깊이를 프리셋별 창으로 검사. F = 1.0을 위·옆·바닥
  근처에서 3 s, 다섯 손 F = 0.8, 푸시 1.0 → 드래그 전환(패치가 목표 0.15 이내)을 검사(유한·뒤집힘 0·부피 ≥ 0.95).
- **반죽**: 접어 융합(슬라임 `welds > 30`, 접은 자리 유지), 임시 점착(말랑이 `welds < 10`), 통과 금지(탱탱볼).
- **멀티터치**: 다섯 손과 열 손(유한·뒤집힘 0), 양손 벌리기(폭 ≥ 1.6 × 정착 폭).
- **릴리즈 곡선**: `release-curve-<프리셋>`이 정착 후 꼭대기를 +1.0 늘렸다 놓고 `maxY`를 샘플해 위 v7 표의
  창을 검사합니다. `press-curve-말랑이` / `press-curve-슬로우`는 손바닥 프레스 후 복귀를 같은 창으로 검사합니다.
- **피드백 신호**: `dropHeight` 낙하가 정확히 한 프레임 `impact > 3`을 보고하고, 유휴 정착 몸은
  `deformRate < 0.05`, `impact === 0`을 보고합니다.
- **늘어남 속성**: `pull-small` 유지 중 표면 `surfaceStretch` 최댓값 ≥ 1.4, 정착 후에는 모든 값이 [0.9, 1.1].
- **색 섞임**: 물감을 얹으면 표면 색 분산이 80 % 이상 유지, 6회 반죽 후 45 % 이상, 30초 반죽 후
  60 % 이하, 색은 [0,1] 유지, 가만히 두면 `colorVersion` 불변.
- **파라미터 검증**: 숨은 키가 빠지면 `setParams` 예외.
- **성능**: 데스크톱 설정(n = 24, spacing 0.17)에서 서브스텝당 ≤ 0.75 ms.

```bash
node tests/physics.smoke.mjs
```

---

## 9. 유지보수 메모

- three.js의 `IcosahedronGeometry`는 UV 이음선을 따라 정점을 복제합니다. `buildBlobGeometry()`는
  `normal`/`uv` 속성을 지운 뒤 `mergeVertices`로 병합하고, 기대 정점 수와 다르면 예외를 던집니다.
- 레이캐스터는 `geometry.boundingSphere`로 조기 종료합니다. `surface.sync()`가 매 프레임
  `body.bounds`로 `boundingSphere`/`boundingBox`를 갱신하므로 변형·이동 중에도 히트가 유지됩니다.
  슬라임(implicit) 모드에서도 레이캐스트 대상은 항상 (숨겨진) 매끈 표면입니다 — `visible`은 레이캐스트에
  영향을 주지 않습니다.
- 노멀은 매 프레임 다시 계산하지 않고 `body.normalsDirty`일 때만 갱신합니다.
- 시뮬레이션은 `body.pos`와 `body.surfaceColor`를 GPU 버퍼로 직접 사용합니다. 메시는 `frustumCulled = false`입니다.
- 사면체화는 표면이 닫혀 있다고 가정합니다. 광선 홀짝 내부 판정에 쓰는 레이가 표면과 정확히 겹치지
  않도록 `tetrahedralize()`는 미세하게 기울인 방향을 씁니다. 사면체 부피가 0 이하이거나 정점 임베딩의
  최소 무게중심이 음수면 예외를 던집니다(무음 보정 없음).
- NaN/폭주 가드: `updateDerived()`가 비정상 정점을 발견하면 즉시 예외를 던집니다(무음 보정 없음).
