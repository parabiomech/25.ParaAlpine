# Para AlpineSki - 종합 분석 대시보드

스키 센서 데이터 분석을 위한 웹 기반 대시보드입니다.

## 주요 기능

### GPS 주행 분석
-  실시간 경로 추적 및 지도 시각화
-  3D GPS 경로 (속도 기반 색상 표시)
-  속도 분석 차트
-  고도 변화 분석
-  재생/일시정지 컨트롤
-  구간 설정 및 저장

### 움직임 분석
-  3축 가속도 센서 데이터
-  3축 자이로스코프 데이터 (라디안 → 도 변환)
-  Orientation 센서 (Quaternion 포함)
-  신호 필터링
  - Butterworth 저역 통과 필터
  - Savitzky-Golay 스무딩 필터
-  턴 시점 자동 검출
  - Quaternion 변화율
  - Quaternion 각도 변화
  - Quaternion Y/Z 피크
  - Roll+Pitch 조합
  - 방향별 턴 분석 (좌/우)

## 사용 방법

### 온라인 버전
[GitHub Pages에서 바로 사용하기](https://your-username.github.io/25.ParaAlpine/)

### 데이터 준비
다음 CSV 파일들이 필요합니다:
- `Location.csv` - GPS 위치 데이터
- `Accelerometer.csv` - 가속도 센서 데이터
- `Gyroscope.csv` - 자이로스코프 센서 데이터
- `Orientation.csv` - 방향 센서 데이터 (선택)
- `Metadata.csv` - 메타데이터 (선택)

## 데이터 형식

### Location.csv
```
time,latitude,longitude,altitude,speed
```

### Accelerometer.csv
```
time,x,y,z
```

### Gyroscope.csv
```
time,x,y,z
```

### Orientation.csv
```
time,azimuth,pitch,roll,qx,qy,qz,qw
```

## 기술 스택
- HTML5 / CSS3 / JavaScript (ES6+)
- [Plotly.js](https://plotly.com/javascript/) - 차트 시각화
- [Leaflet.js](https://leafletjs.com/) - 지도 시각화
- OpenStreetMap - 지도 타일

## 라이선스
MIT License

## 개발자
Para AlpineSki Analysis Dashboard

---
**Note**: 이 대시보드는 클라이언트 사이드에서만 동작하며, 모든 데이터는 브라우저 내에서만 처리됩니다.
