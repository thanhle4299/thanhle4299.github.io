import { Animator, BoxCollider, boxRaycast, Camera, Collider2D, CollisionInfo2D, Color, dot, Entity, InputManager, Keys, Light2D, LineRenderer, MathUtils, minus, mul, ParticleSystem, plus, ShadowType, Time, Timeline, TouchState, vec2, vec4, Vector2 } from "zogra-engine";
import { FoodGenerator } from "./food-generator";
import { BlackHole } from "./black-hole";
import { ColorFood } from "./color-food";
import { Food, IFood } from "./food";
import { GameMap } from "./map";
import { BoostFood } from "./boost-food";
import { GameCamera } from "./game-camera";
import { SnakeGame } from ".";
import { Block, EatEvent, InitialData } from "./score";
import { Structure } from "./struct";

interface SnakeGrowing
{
    length: number;
    headSpeed: number;
    tailSpeed: number;
}

interface SnakeBoost
{
    speed: number;
    duration: number;
}

const Tracks = {
    light: 0,
    camera: 1,
    boost: 2
};

export class Snake extends LineRenderer
{
    initialLightRange = 15;
    initialLightIntensity = 0.4;
    initialAmbient = 0.2;
    maxLightIntensity = 0.6;

    intensityDropDamping = () => 16 * Math.log(this.actualLength);
    lightRangeDropDamping = () => 50 * Math.log(this.actualLength);
    ambientDropDamping = () => 10                                                                                                                                                                         * Math.log(this.actualLength);

    speed = 3;
    width = 0.6;
    inputCacheSize = 3;
    step = 1;
    color = Color.white;
    headMoveDistance = 0;
    tailMoveDistance = 0;
    currentLength: number;
    actualLength: number;
    boostTimeout = -1;
    isDead = false;

    state: Block;
    histories: Block[] = [];

    bodies: vec2[] = [];
    headDir: vec2 = vec2.right();
    inputQueue: vec2[] = [];
    camera: GameCamera;
    input: InputManager;
    touchStart = vec2.zero();
    touchThreshold = 0.1;

    foodGenerator: FoodGenerator;
    growingQueue: SnakeGrowing[] = [];
    foodParticle = new ParticleSystem();
    deadParticle = new ParticleSystem();
    headEntity: Entity;
    light = new Light2D();
    animator = new Animator(this);

    get ambientIntensity() { return SnakeGame.instance.engine.renderPipeline.ambientIntensity }
    set ambientIntensity(v) { SnakeGame.instance.engine.renderPipeline.ambientIntensity = v }

    constructor(bodies: vec2[], headDir: vec2, camera: GameCamera, input: InputManager)
    {
        super();
        this.currentLength = bodies.length;
        this.actualLength = bodies.length;
        this.color = new Color(1.8, 1.8, 1.8, 1);
        this.bodies = bodies;
        this.headDir = headDir;
        this.camera = camera;
        camera.position = this.head.toVec3(camera.position.z);
        this.input = input;
        this.foodGenerator = new FoodGenerator(this);
        const collider = new BoxCollider();
        collider.size = vec2(this.width);
        this.collider = collider;
        collider.on("onContact", this.onContact.bind(this));

        this.headEntity = new Entity();

        this.foodParticle.maxCount = 256;
        this.foodParticle.startColor = () => new Color(1, 1, 1, 1).mul(MathUtils.lerp(1, 3, Math.random())) as Color;
        this.foodParticle.startAcceleration = { x: 0, y: 0, z: 0 };
        this.foodParticle.lifeSpeed = [10, 0];
        this.foodParticle.lifetime = [0.3, 0.4];
        this.foodParticle.lifeSize = [0.3, 0];

        this.deadParticle.maxCount = 256;
        this.deadParticle.startColor = () => new Color(1, 1, 1, 1).mul(MathUtils.lerp(2, 5, Math.random())) as Color;
        this.deadParticle.startAcceleration = { x: 0, y: 0, z: 0 };
        this.deadParticle.lifeSpeed = [3, 0];
        this.deadParticle.lifetime = [0.4, 1];
        this.deadParticle.lifeSize = [0.3, 0];

        this.light.shadowType = ShadowType.Soft;
        this.light.lightRange = 15;
        this.light.intensity = 0;
        this.light.lightColor = new Color(1, 1, 1, 1);
        this.light.volumnRadius = this.width / 3;
        this.light.attenuation = -0.8;
        this.ambientIntensity = 0;

        for (const body of this.bodies)
        {
            this.points.push({
                position: body.clone(),
                color: this.color,
                width: this.width,
            });
        }
        this.points.push({
            position: mul(headDir, this.width / 2).plus(this.head),
            color: this.color,
            width: this.width,
        });
        this.points[0].position = mul(this.tailDir, -this.width / 2).plus(this.tail);

        this.headEntity.position = vec2.mul(this.headDir, -this.width / 2).plus(this.points[this.points.length - 1].position).toVec3(0);

        const data = new InitialData();
        data.length = this.actualLength;
        data.seed = 0;
        this.state = Block.new(data);
        this.histories.push(this.state);
    }
    start()
    {
        this.scene?.add(this.foodGenerator);
        this.scene?.add(this.foodParticle);
        this.scene?.add(this.deadParticle);
        this.scene?.add(this.headEntity);
        this.scene?.add(this.light, this.headEntity);

        this.animator.playProceduralOn(Tracks.light, 1, (t, dt) =>
        {
            this.light.intensity = MathUtils.lerp(0, this.initialLightIntensity, t);
            this.ambientIntensity = MathUtils.lerp(0, this.initialAmbient, t);
        });
    }
    update(time: Time)
    {
        this.animator.update(time.deltaTime);
        if (!this.isDead)
        {
            this.decayLight(time);
            this.handleInput();
        }

        let headMovement = this.speed * time.deltaTime;
        let tailMovement = this.speed * time.deltaTime;
        let isGrowing = false;
        if (this.growingQueue.length > 0)
        {
            isGrowing = true;
            const growing = this.growingQueue[0];
            headMovement =growing.headSpeed * this.speed * time.deltaTime;
            tailMovement =growing.tailSpeed * this.speed * time.deltaTime;
            let totalMovement = headMovement - tailMovement;
            if (Math.sign(growing.length - (this.currentLength + totalMovement)) !== Math.sign(totalMovement))
            {
                const dt = Math.abs(growing.length - this.currentLength) / Math.abs(totalMovement) * time.deltaTime;
                this.growingQueue = this.growingQueue.slice(1);
                if (this.growingQueue.length > 0)
                {
                    headMovement = growing.headSpeed * this.speed * dt + (time.deltaTime - dt) * this.growingQueue[0].headSpeed * this.speed;
                    tailMovement = growing.tailSpeed * this.speed * dt + (time.deltaTime - dt) * this.growingQueue[0].tailSpeed * this.speed;
                }
                else
                {
                    headMovement = growing.headSpeed * this.speed * dt + (time.deltaTime - dt) * this.speed;
                    tailMovement = growing.tailSpeed * this.speed * dt + (time.deltaTime - dt) * this.speed;
                }
            }
        }
        
        this.moveHead(headMovement);
        this.moveTail(tailMovement);
        this.updateMesh();

        if (!this.isDead)
        {
            this.checkHitSelf();

            // Change camera view range by move speed.
            const headSpeed = headMovement / time.deltaTime;
            let viewHeight = MathUtils.mapClamped(0, 6, 7, 13, headSpeed);
            let damping = headSpeed <= 3.1 ? 2 : 0.5;
            if (SnakeGame.instance.canvas.height > SnakeGame.instance.canvas.width)
            {
                viewHeight *= 1.2;
                damping = headSpeed <= 3.1 ? 1 : 0.3;
            }
            this.camera.viewHeight = MathUtils.damp(this.camera.viewHeight, viewHeight, damping, time.deltaTime);

            // Move head entity and collider
            this.headEntity.position = vec2.mul(this.headDir, -this.width / 2).plus(this.points[this.points.length - 1].position).toVec3(0);
            const collider = this.collider as BoxCollider;
            collider.offset = this.headEntity.position.toVec2();
        }
    }
    moveHead(distance: number)
    {
        if (this.bodies.length <= 0 || this.points.length <= 0)
            return;
        this.headMoveDistance += distance;
        this.currentLength += distance;
        if (this.headMoveDistance >= this.step)
        {
            this.bodies.push(mul(this.headDir, this.step).plus(this.head));

            while (this.inputQueue.length > 0)
            {
                if (dot(this.inputQueue[0], this.headDir) >= 0)
                {
                    this.headDir = this.inputQueue[0];
                    this.inputQueue = this.inputQueue.slice(1);
                    break;
                }
                this.inputQueue = this.inputQueue.slice(1);
            }
            let nextPos = plus(this.head, this.headDir);
            if (GameMap.instance.getTile(nextPos) === GameMap.tileGround)
                GameMap.instance.setTile(plus(this.head, this.headDir), GameMap.tileSnake);

            this.points[this.points.length - 1].position = this.head.clone();
            this.points.push({
                position: mul(this.headDir, this.width / 2).plus(this.head),
                color: this.color,
                width: this.width,
            });
            this.headMoveDistance -= this.step;
        }

        const headPoint = this.points[this.points.length - 1];
        const startPos = mul(this.headDir, this.width / 2).plus(this.head);
        headPoint.position.set(this.headDir).mul(this.headMoveDistance).plus(startPos);
    }
    moveTail(distance: number)
    {
        if (this.bodies.length <= 0 || this.points.length <= 0)
            return;
        this.currentLength -= distance;

        while (distance > 0)
        {
            if (this.tailMoveDistance + distance >= this.step)
            {
                distance -= this.step - this.tailMoveDistance;
                this.tailMoveDistance = this.step;
                if (GameMap.instance.getTile(this.tail) === GameMap.tileSnake)
                    GameMap.instance.setTile(this.tail, GameMap.tileGround);
                this.bodies = this.bodies.slice(1);
                this.points = this.points.slice(1);

                this.tailMoveDistance -= this.step;
            }
            else
            {
                this.tailMoveDistance += distance;
                distance -= distance;
            }
            
            if (!this.tail)
                return;
            const tailPoint = this.points[0];
            const startPos = mul(this.tailDir, -this.width / 2).plus(this.tail);
            tailPoint.position.set(this.tailDir).mul(this.tailMoveDistance).plus(startPos);
        }
    }

    onContact(other: Collider2D)
    {
        if (this.isDead)
            return;
        if (other.entity instanceof GameMap)
        {
            this.dead();
        }
        if ((other.entity as unknown as IFood)?.score !== undefined)
        {
            this.eat(other.entity as IFood & Entity);
        }
    }
    eat(food: Entity & IFood)
    {
        {
            this.histories.push(food.stateBlock);
            const data = new EatEvent();
            data.x = food.position.x;
            data.y = food.position.y;
            data.food = food.stateBlock.hash as Uint8Array;
            this.state = Block.new(data, this.state);
            this.histories.push(this.state);

        }
        if (food instanceof Food)
        {
            this.growTail(food.score, food.score + 1);
            this.foodParticle.emit(9, food.position);
            food.destroy();

            const range = MathUtils.lerp(this.light.lightRange, this.initialLightRange, 0.8);
            let intensity = MathUtils.lerp(this.light.intensity, this.maxLightIntensity, 0.5);
            intensity = Math.min(intensity, this.maxLightIntensity - this.ambientIntensity);
            this.animator.playProceduralOn(Tracks.light, 2, t =>
            {
                this.light.lightRange = MathUtils.lerp(this.light.lightRange, range, t);
                this.light.intensity = MathUtils.lerp(this.light.intensity, intensity, t);
            })
        }
        else if (food instanceof ColorFood)
        {
            this.growTail(food.score, food.score + 1);
            // this.actualLength += 3;
            const colorFood = food as ColorFood;
            const originalColor = this.foodParticle.startColor;
            // this.light.lightColor.plus(colorFood.color).mul(0.5);
            this.foodParticle.startColor = () => vec4.mul(Color.white, colorFood.color, MathUtils.lerp(0.3, 2, Math.random())) as Color;
            this.foodParticle.emit(16, food.position);
            this.foodParticle.startColor = originalColor;
            food.destroy();

            const range = this.initialLightRange;
            const intensity = this.initialLightIntensity;
            const ambient = this.initialAmbient;
            const color = colorFood.color.plus(this.light.lightColor).mul(0.5);
            this.animator.playProceduralOn(Tracks.light, 3, t =>
            {
                this.light.lightRange = MathUtils.lerp(this.light.lightRange, range, t);
                this.light.intensity = Math.min(this.maxLightIntensity - this.ambientIntensity, MathUtils.lerp(this.light.intensity, intensity, t));
                this.light.lightColor = vec4.mathNonAlloc(MathUtils.lerp)(this.light.lightColor, this.light.lightColor, color, vec4(t)) as Color;
                this.ambientIntensity = MathUtils.lerp(this.ambientIntensity, ambient, t);
            })
        }
        else if (food instanceof BoostFood)
        {
            if (this.boostTimeout > 0)
                clearTimeout(this.boostTimeout);
            this.foodParticle.emit(9, food.position);
            food.destroy();

            const boostSpeed = Math.sqrt(this.speed ** 2 + 10);
            // this.boostAnimator.clear();
            this.animator.playOn(Tracks.boost, Timeline({
                duration: 10,
                frames: {
                    [0]: {
                        speed: this.speed,
                    },
                    [1]: {
                        speed: boostSpeed,
                    },
                    [8]: {
                        speed: boostSpeed,
                    },
                    [10]: {
                        speed: 3,
                    }
                },
                updater: (frame, target: Snake) =>
                {
                    target.speed = frame.speed;
                }
            }), this);
            this.animator.playOn(Tracks.camera, Timeline({
                duration: 0.9,
                frames: {
                    [0]: {
                        shake: 5,
                        amplitude: 0.6,
                    },
                    [0.9]: {
                        shake: 0,
                        amplitude: 0
                    },
                },
                updater: (frame, camera: GameCamera) =>
                {
                    camera.shake = frame.shake;
                    camera.shakeAmplitude = frame.amplitude;
                }
            }), this.camera);
        }
        else if (food instanceof BlackHole)
        {
            // this.growTail(2 - this.currentLength, 2);
            // this.growTail(this.currentLength - 2, this.currentLength - 2);
            const shrinkTime = 1;
            this.growingQueue = [];
            this.enqueueGrowing({
                length: 2,
                headSpeed: 0,
                tailSpeed: (this.actualLength - 2) / shrinkTime / this.speed,
            });
            this.enqueueGrowing({
                length: this.actualLength,
                headSpeed: 1,
                tailSpeed: 0
            });
            // this.cameraAnimator.clear();
            this.animator.playOn(Tracks.camera, Timeline({
                duration: 1.5,
                frames: {
                    [0]: {
                        shake: 0,
                        amplitude: 0,
                    },
                    [0.2]: {
                        shake: 10,
                        amplitude: 0.3,
                    },
                    [1]: {
                        shake: 10,
                        amplitude: 0.3
                    },
                    [1.5]: {
                        shake: 0,
                        amplitude: 0,
                    }
                },
                updater: (frame, camera: GameCamera) =>
                {
                    camera.shake = frame.shake;
                    camera.shakeAmplitude = frame.amplitude;
                }
            }), this.camera);
            const colorFood = food as BlackHole;
            const originalColor = this.foodParticle.startColor;
            this.foodParticle.startColor = () => Color.black;
            this.foodParticle.emit(16, food.position);
            this.foodParticle.startColor = originalColor;
            food.destroy();

            const range = this.light.lightRange * 0.8;
            const intensity = this.light.intensity * 0.8;
            const ambient = this.ambientIntensity * 0.2;
            this.animator.playProceduralOn(Tracks.light, 2, (t, dt) =>
            {
                this.light.lightRange = MathUtils.damp(this.light.lightRange, range, 2, dt);
                this.light.intensity = MathUtils.damp(this.light.intensity, intensity, 2, dt);
                this.ambientIntensity = MathUtils.damp(this.ambientIntensity, ambient, 2, dt);
            });
        }
    }
    decayLight(time: Time)
    {
        this.light.intensity = MathUtils.damp(this.light.intensity, 0, this.intensityDropDamping(), time.deltaTime);
        this.ambientIntensity = MathUtils.damp(this.ambientIntensity, 0, this.ambientDropDamping(), time.deltaTime);
        this.light.lightRange = MathUtils.damp(this.light.lightRange, 0, this.lightRangeDropDamping(), time.deltaTime);
    }
    handleInput()
    {
        if (this.input.getKeyDown(Keys.A) || this.input.getKeyDown(Keys.Left))
        {
            this.inputQueue.push(vec2.left());
        }
        if (this.input.getKeyDown(Keys.D) || this.input.getKeyDown(Keys.Right))
        {
            this.inputQueue.push(vec2.right());
        }
        if (this.input.getKeyDown(Keys.W) || this.input.getKeyDown(Keys.Up))
        {
            this.inputQueue.push(vec2.up());
        }
        if (this.input.getKeyDown(Keys.S) || this.input.getKeyDown(Keys.Down))
        {
            this.inputQueue.push(vec2.down());
        }
        
        if (this.input.touches[0])
        {
            if (this.input.touches[0].state & TouchState.Started)
            {
                this.touchStart = this.input.touches[0].pos;
            }
            else
            {
                const delta = vec2.minus(this.input.touches[0].pos, this.touchStart);
                const screenSize = SnakeGame.instance.canvas.width > SnakeGame.instance.canvas.height
                    ? SnakeGame.instance.canvas.height
                    : SnakeGame.instance.canvas.width;
                if (Math.abs(delta.x) / screenSize > this.touchThreshold || Math.abs(delta.y) / screenSize > this.touchThreshold)
                {
                    if (Math.abs(delta.x) > Math.abs(delta.y))
                        this.inputQueue.push(vec2(Math.sign(delta.x), 0));
                    else
                        this.inputQueue.push(vec2(0, -Math.sign(delta.y)));
                    this.touchStart = this.input.touches[0].pos;
                }
            }

        }
        if (this.inputQueue.length > this.inputCacheSize)
            this.inputQueue = this.inputQueue.slice(this.inputQueue.length - this.inputCacheSize);
    }
    checkHitSelf()
    {
        for (let i = 0; i < this.bodies.length - 1; i++)
        {
            if (Vector2.distance(this.points[this.points.length - 1].position, this.bodies[i]) < this.width / 2)
            {
                this.dead();
                return;
            }
        }
    }
    enqueueGrowing(growing: SnakeGrowing)
    {
        this.growingQueue.push(growing);
    }
    growTail(length: number, steps: number)
    {
        this.actualLength += length;
        this.growingQueue.push({
            length: this.actualLength,
            headSpeed: 1,
            tailSpeed: (steps - length) / steps
        });
    }
    reverse()
    {
        const headDir = this.tailDir.negate();
        this.bodies.push(mul(this.headDir, this.step).plus(this.head));
        this.bodies = this.bodies.slice(1);

        this.bodies = this.bodies.reverse();
        this.points = this.points.reverse();
        [this.headMoveDistance, this.tailMoveDistance] = [this.step - this.tailMoveDistance, this.step - this.headMoveDistance];
        this.headDir = headDir;
        this.updateMesh();
    }
    async dead()
    {
        this.isDead = true;
        this.growingQueue = [];
        // this.speed = 0;
        this.animator.playProceduralOn(Tracks.light, 1, (t, dt) =>
        {
            this.light.intensity = MathUtils.damp(this.light.intensity, this.initialLightIntensity, 1, dt);
            this.ambientIntensity = MathUtils.damp(this.ambientIntensity, this.initialAmbient, 1, dt);
        });
        const lightEntity = this.headEntity;
        this.headEntity = new Entity();

        this.reverse();

        let time = 3;
        const speed = Math.max(this.speed, this.currentLength / time);
        time = this.currentLength / speed;
        this.enqueueGrowing({
            headSpeed: 0,
            tailSpeed: speed / this.speed,
            length: 0,
        });
        this.camera.shake = 6;
        this.camera.shakeAmplitude = 3;
        this.camera.shakeOctave = 2;
        this.animator.playProceduralOn(Tracks.camera, time, (_, dt) =>
        {
            this.camera.shake = MathUtils.damp(this.camera.shake, 0, time, dt, 0.01);
            this.camera.shakeAmplitude = MathUtils.damp(this.camera.shakeAmplitude, 0.2, time, dt);
        });

        await this.animator.playProcedural(time + 1, (_, dt) =>
        {
            this.light.intensity = MathUtils.damp(this.light.intensity, 0, time, dt);
            if (this.points.length <= 1)
                return;
            const pos = this.points[0].position;
            lightEntity.position = this.tailDir.mul(this.width / 2).plus(pos).toVec3();
            this.deadParticle.emit(1, lightEntity.position);
        });

        this.camera.shake = 0;
        SnakeGame.instance.eventEmitter.emit("gameover", { length: this.actualLength, data: this.histories });
    }
    get head() { return this.bodies[this.bodies.length - 1] }
    get tail() { return this.bodies[0] }
    get tailDir()
    {
        if (this.bodies.length > 1)
            return minus(this.bodies[1], this.bodies[0]).normalize();
        return this.headDir.clone();
    }
}